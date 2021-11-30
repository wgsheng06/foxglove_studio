// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as base64 from "@protobufjs/base64";
import protobufjs from "protobufjs";
import { FileDescriptorSet } from "protobufjs/ext/descriptor";
import { v4 as uuidv4 } from "uuid";

import Log from "@foxglove/log";
import { Time, fromNanoSec, isLessThan } from "@foxglove/rostime";
import PlayerProblemManager from "@foxglove/studio-base/players/PlayerProblemManager";
import {
  MessageEvent,
  Player,
  PlayerCapabilities,
  PlayerState,
  SubscribePayload,
  Topic,
  PlayerPresence,
  PlayerMetricsCollectorInterface,
  AdvertiseOptions,
} from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import debouncePromise from "@foxglove/studio-base/util/debouncePromise";
import { TimestampMethod } from "@foxglove/studio-base/util/time";
import { Channel, ChannelId, FoxgloveClient, SubscriptionId } from "@foxglove/ws-protocol";

import protobufDefinitionsToDatatypes from "./protobufDefinitionsToDatatypes";

const log = Log.getLogger(__dirname);

const CAPABILITIES = [PlayerCapabilities.advertise];

const ZERO_TIME = Object.freeze({ sec: 0, nsec: 0 });

type ParsedChannel = {
  channel: Channel;
  fullSchemaName: string;
  deserializer: (data: ArrayBufferView) => unknown;
  datatypes: RosDatatypes;
};

function parseChannel(channel: Channel): ParsedChannel {
  if (channel.encoding !== "protobuf") {
    throw new Error(`Unsupported encoding ${channel.encoding}`);
  }
  const decodedSchema = new Uint8Array(base64.length(channel.schema));
  if (base64.decode(channel.schema, decodedSchema, 0) !== decodedSchema.byteLength) {
    throw new Error(`Failed to decode base64 schema on ${channel.topic}`);
  }
  const root = protobufjs.Root.fromDescriptor(FileDescriptorSet.decode(decodedSchema));
  root.resolveAll();
  const type = root.lookupType(channel.schemaName);

  const deserializer = (data: ArrayBufferView) => {
    return type.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  };

  const datatypes: RosDatatypes = new Map();
  protobufDefinitionsToDatatypes(datatypes, type);

  return { channel, fullSchemaName: type.fullName, deserializer, datatypes };
}

export default class FoxgloveWebSocketPlayer implements Player {
  private _url: string; // WebSocket URL.
  private _name: string;
  private _client?: FoxgloveClient; // The client when we're connected.
  private _id: string = uuidv4(); // Unique ID for this player.
  private _listener?: (arg0: PlayerState) => Promise<void>; // Listener for _emitState().
  private _closed: boolean = false; // Whether the player has been completely closed using close().
  private _topics?: Topic[]; // Topics as published by the WebSocket.
  private _datatypes?: RosDatatypes; // Datatypes as published by the WebSocket.
  private _start?: Time; // The time at which we started playing.
  private _parsedMessages: MessageEvent<unknown>[] = []; // Queue of messages that we'll send in next _emitState() call.
  private _messageOrder: TimestampMethod = "receiveTime";
  private _receivedBytes: number = 0;
  private _metricsCollector: PlayerMetricsCollectorInterface;
  private _hasReceivedMessage = false;
  private _presence: PlayerPresence = PlayerPresence.NOT_PRESENT;
  private _problems = new PlayerProblemManager();
  private _lastSeekTime = 0;
  private _currentTime?: Time;

  private _unresolvedSubscriptions = new Set<string>();
  private _resolvedSubscriptionsByTopic = new Map<string, SubscriptionId>();
  private _resolvedSubscriptionsById = new Map<SubscriptionId, ParsedChannel>();
  private _channelsByTopic = new Map<string, ParsedChannel>();
  private _channelsById = new Map<ChannelId, ParsedChannel>();

  constructor({
    url,
    metricsCollector,
  }: {
    url: string;
    metricsCollector: PlayerMetricsCollectorInterface;
  }) {
    this._presence = PlayerPresence.INITIALIZING;
    this._metricsCollector = metricsCollector;
    this._url = url;
    this._name = url;
    this._metricsCollector.playerConstructed();
    this._open();
  }

  private _open = (): void => {
    if (this._closed) {
      return;
    }
    if (this._client != undefined) {
      throw new Error(`Attempted to open a second Foxglove WebSocket connection`);
    }
    log.info(`Opening connection to ${this._url}`);

    const client = new FoxgloveClient({
      ws: new WebSocket(this._url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]),
    });

    client.on("open", () => {
      if (this._closed) {
        return;
      }
      this._presence = PlayerPresence.PRESENT;
      this._problems.clear();
      this._channelsById.clear();
      this._channelsByTopic.clear();
      this._client = client;
    });

    client.on("error", (err) => {
      log.error(err);
    });

    client.on("close", (event) => {
      log.info("Connection closed:", event);
      this._presence = PlayerPresence.RECONNECTING;

      for (const topic of this._resolvedSubscriptionsByTopic.keys()) {
        this._unresolvedSubscriptions.add(topic);
      }
      this._resolvedSubscriptionsById.clear();
      this._resolvedSubscriptionsByTopic.clear();
      delete this._client;

      this._problems.addProblem("ws:connection-failed", {
        severity: "error",
        message: "Connection failed",
        tip: `Check that the WebSocket server at ${this._url} is reachable.`,
      });

      this._emitState();

      // Try connecting again.
      setTimeout(this._open, 3000);
    });

    client.on("serverInfo", (event) => {
      this._name = `${this._url}\n${event.name}`;
      this._emitState();
    });

    client.on("status", (event) => {
      log.info("Status:", event);
    });

    client.on("advertise", (newChannels) => {
      for (const channel of newChannels) {
        let parsedChannel;
        try {
          parsedChannel = parseChannel(channel);
        } catch (error) {
          this._problems.addProblem(`schema:${channel.topic}`, {
            severity: "error",
            message: `Failed to parse channel schema on ${channel.topic}`,
            error,
          });
          this._emitState();
          continue;
        }
        const existingChannel = this._channelsByTopic.get(channel.topic);
        if (existingChannel) {
          this._problems.addProblem(`duplicate-topic:${channel.topic}`, {
            severity: "error",
            message: `Multiple channels advertise the same topic: ${channel.topic} (${existingChannel.channel.id} and ${channel.id})`,
          });
          this._emitState();
          continue;
        }
        this._channelsById.set(channel.id, parsedChannel);
        this._channelsByTopic.set(channel.topic, parsedChannel);
      }
      this._updateTopicsAndDatatypes();
      this._emitState();
      this._processUnresolvedSubscriptions();
    });

    client.on("unadvertise", (removedChannels) => {
      for (const id of removedChannels) {
        const chanInfo = this._channelsById.get(id);
        if (!chanInfo) {
          this._problems.addProblem(`unadvertise:${id}`, {
            severity: "error",
            message: `Server unadvertised channel ${id} that was not advertised`,
          });
          this._emitState();
          continue;
        }
        for (const [subId, { channel }] of this._resolvedSubscriptionsById) {
          if (channel.id === id) {
            this._resolvedSubscriptionsById.delete(subId);
            this._resolvedSubscriptionsByTopic.delete(channel.topic);
            client.unsubscribe(subId); // TODO: batch
          }
        }
        this._channelsById.delete(id);
        this._channelsByTopic.delete(chanInfo.channel.topic);
      }
      this._updateTopicsAndDatatypes();
      this._emitState();
    });

    client.on("message", ({ subscriptionId, timestamp, data }) => {
      if (!this._hasReceivedMessage) {
        this._hasReceivedMessage = true;
        this._metricsCollector.recordTimeToFirstMsgs();
      }
      const chanInfo = this._resolvedSubscriptionsById.get(subscriptionId);
      if (!chanInfo) {
        throw new Error(`Received message on unknown subscription ${subscriptionId}`);
      }

      try {
        this._parsedMessages.push({
          topic: chanInfo.channel.topic,
          receiveTime: fromNanoSec(timestamp),
          message: chanInfo.deserializer(data),
          sizeInBytes: data.byteLength,
        });
      } catch (error) {
        this._problems.addProblem(`message:${chanInfo.channel.topic}`, {
          severity: "error",
          message: `Failed to parse message on ${chanInfo.channel.topic}`,
          error,
        });
        this._emitState();
        throw error;
      }
      this._emitState();
    });
  };

  private _updateTopicsAndDatatypes() {
    this._topics = Array.from(this._channelsById.values(), (chanInfo) => ({
      name: chanInfo.channel.topic,
      datatype: chanInfo.fullSchemaName,
    }));
    this._datatypes = new Map();
    for (const { datatypes } of this._channelsById.values()) {
      for (const [name, types] of datatypes) {
        this._datatypes.set(name, types);
      }
    }
    this._emitState();
  }

  // Potentially performance-sensitive; await can be expensive
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  private _emitState = debouncePromise(() => {
    if (!this._listener || this._closed) {
      return Promise.resolve();
    }

    const { _topics, _datatypes } = this;
    if (!_topics || !_datatypes) {
      return this._listener({
        name: this._name,
        presence: this._presence,
        progress: {},
        capabilities: CAPABILITIES,
        playerId: this._id,
        activeData: undefined,
        problems: this._problems.problems(),
      });
    }

    const currentTime =
      this._parsedMessages.length > 0
        ? this._parsedMessages[this._parsedMessages.length - 1]!.receiveTime
        : this._currentTime;
    if (!this._start) {
      this._start = currentTime;
    }
    if (currentTime && this._currentTime && isLessThan(currentTime, this._currentTime)) {
      ++this._lastSeekTime;
    }
    this._currentTime = currentTime;

    const messages = this._parsedMessages;
    this._parsedMessages = [];
    return this._listener({
      name: this._name,
      presence: this._presence,
      progress: {},
      capabilities: CAPABILITIES,
      playerId: this._id,
      problems: this._problems.problems(),

      activeData: {
        messages,
        totalBytesReceived: this._receivedBytes,
        messageOrder: this._messageOrder,
        startTime: this._start ?? ZERO_TIME,
        endTime: currentTime ?? ZERO_TIME,
        currentTime: currentTime ?? ZERO_TIME,
        isPlaying: true,
        speed: 1,
        lastSeekTime: this._lastSeekTime,
        topics: _topics,
        datatypes: _datatypes,
        parsedMessageDefinitionsByTopic: {},
      },
    });
  });

  setListener(listener: (arg0: PlayerState) => Promise<void>): void {
    this._listener = listener;
    this._emitState();
  }

  close(): void {
    this._closed = true;
    if (this._client) {
      this._client.close();
    }
    this._metricsCollector.close();
    this._hasReceivedMessage = false;
  }

  setSubscriptions(subscriptions: SubscribePayload[]): void {
    if (!this._client || this._closed) {
      return;
    }
    const newTopics = new Set(subscriptions.map(({ topic }) => topic));

    for (const topic of newTopics) {
      if (!this._resolvedSubscriptionsByTopic.has(topic)) {
        this._unresolvedSubscriptions.add(topic);
      }
    }

    for (const [topic, subId] of this._resolvedSubscriptionsByTopic) {
      if (!newTopics.has(topic)) {
        this._client.unsubscribe(subId); // TODO: batch?
        this._resolvedSubscriptionsByTopic.delete(topic);
        this._resolvedSubscriptionsById.delete(subId);
      }
    }
    for (const topic of this._unresolvedSubscriptions) {
      if (!newTopics.has(topic)) {
        this._unresolvedSubscriptions.delete(topic);
      }
    }

    this._processUnresolvedSubscriptions();
  }

  private _processUnresolvedSubscriptions() {
    if (!this._client) {
      return;
    }

    for (const topic of this._unresolvedSubscriptions) {
      const chanInfo = this._channelsByTopic.get(topic);
      if (chanInfo) {
        const subId = this._client.subscribe(chanInfo.channel.id); //TODO: batch?
        this._unresolvedSubscriptions.delete(topic);
        this._resolvedSubscriptionsByTopic.set(topic, subId);
        this._resolvedSubscriptionsById.set(subId, chanInfo);
      }
    }
  }

  setPublishers(publishers: AdvertiseOptions[]): void {
    if (publishers.length > 0) {
      throw new Error("Publishing is not supported by the Foxglove WebSocket connection");
    }
  }

  setParameter(): void {
    throw new Error("Parameter editing is not supported by the Foxglove WebSocket connection");
  }

  publish(): void {
    throw new Error("Publishing is not supported by the Foxglove WebSocket connection");
  }

  requestBackfill(): void {}
  setGlobalVariables(): void {}
}

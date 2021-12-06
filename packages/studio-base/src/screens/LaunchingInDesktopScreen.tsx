// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Link, Stack, Text, useTheme } from "@fluentui/react";
import { ReactElement, useEffect } from "react";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { useSessionStorageValue } from "@foxglove/studio-base/hooks/useSessionStorageValue";

export function LaunchingInDesktopScreen(): ReactElement {
  const theme = useTheme();
  const [, setLaunchPreference] = useSessionStorageValue(AppSetting.LAUNCH_PREFERENCE);

  const cleanWebURL = new URL(window.location.href);
  cleanWebURL.searchParams.delete("launch");

  function openWeb() {
    setLaunchPreference("web");
    window.location.href = cleanWebURL.href;
  }

  useEffect(() => {
    const desktopURL = new URL("foxglove://open");
    cleanWebURL.searchParams.forEach((k, v) => {
      if (k && v) {
        desktopURL.searchParams.set(k, v);
      }
    });

    window.location.href = desktopURL.href;
  });

  return (
    <Stack horizontalAlign="center" verticalAlign="center" verticalFill>
      <Stack
        horizontalAlign="center"
        verticalAlign="center"
        verticalFill
        tokens={{ childrenGap: theme.spacing.l1, maxWidth: 480 }}
        styles={{ root: { textAlign: "center" } }}
      >
        <Text variant="xxLarge">Launching Foxglove Studio…</Text>
        <Text>We’ve directed you to the desktop app.</Text>
        <Stack tokens={{ childrenGap: theme.spacing.s2 }}>
          <Text>
            You can also <Link onClick={openWeb}>open this link in your browser</Link>.
          </Text>
          <Text>
            Don’t have the app installed?&nbsp;
            <Link href="https://foxglove.dev/download">Download Foxglove Studio</Link>
          </Text>
        </Stack>
      </Stack>
    </Stack>
  );
}

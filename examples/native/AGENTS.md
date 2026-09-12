# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Native validation

Preserve the committed-intent dependency lockfile when refreshing the local TuneJS tarball. Do not use `--package-lock=false`: an observed refresh drifted Expo dependencies and the resulting app crashed; restoring the pinned dependency tree and rebuilding succeeded. Refresh `node_modules/tunejs` from the staged package with a checksum-based copy; npm normalizes tarball mtimes, so size/mtime quick checks can miss same-size changes. Compare installed TuneJS files with the fresh staged package because the development version stays unchanged. A TypeScript check alone does not establish a fresh simulator or device build.

For isolated offline-fixture evidence, run the root `scripts/serve.mjs` with the new package-check directory as its working directory. Its result path is relative to that working directory. Use a separate run directory for each evidence capture so historical `artifacts/native-results.json` is not overwritten. Do not treat simulator offline fixtures as physical-device, microphone, lifecycle or audible-output validation.

The example app carries a network security config permitting cleartext only to 10.0.2.2 (emulator host alias) and 127.0.0.1 (adb reverse to the host for physical devices) for local fixture reporting (mirroring the iOS `NSAllowsLocalNetworking` entry); it is example-app configuration, not library behavior.

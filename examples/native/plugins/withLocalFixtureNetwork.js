// Permits cleartext HTTP only to the Android emulator host alias 10.0.2.2 so the
// example app can POST local fixture results. Mirrors the iOS NSAllowsLocalNetworking entry.
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs/promises');
const path = require('path');

const NETWORK_SECURITY_CONFIG = `<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`;

const withLocalFixtureNetwork = config => {
  config = withAndroidManifest(config, config => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ ?? {};
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return config;
  });
  return withDangerousMod(config, ['android', async config => {
    const dir = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'network_security_config.xml'), `${NETWORK_SECURITY_CONFIG}\n`);
    return config;
  }]);
};

module.exports = withLocalFixtureNetwork;

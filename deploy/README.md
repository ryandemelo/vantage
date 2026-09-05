# Deployment

Everything here is generated. Edit `policy.example.json`, then run:

```
node tools/make-policy.js
node tools/make-policy.js my-policy.json
```

Every key is validated against `policy/managed_schema.json` first, so a typo or
a wrong type fails at generation rather than being silently ignored by the
browser at runtime.

## Files

| File | Use |
| --- | --- |
| `policy.example.json` | The payload. This is the only file you edit |
| `windows/vantage-edge.reg` | Import directly, or use as the source for a GPO preference item |
| `windows/vantage-chrome.reg` | Same for Chrome |
| `linux/vantage.json` | Copy to `/etc/opt/edge/policies/managed/` or `/etc/opt/chrome/policies/managed/` |
| `macos/vantage-policy.sh` | Writes the managed preferences. For production, use an MDM profile with the same values |

## Intune

Use a Settings Catalog profile, or a custom profile with OMA-URI settings under:

```
./Device/Vendor/MSFT/Policy/Config/microsoft_edge~Policy~microsoft_edge/ExtensionInstallForcelist
./Device/Vendor/MSFT/Policy/Config/microsoft_edge~Policy~microsoft_edge/ExtensionSettings
```

The values are the same strings that appear in the generated `.reg` file.

## Group Policy

Import the Edge or Chrome ADMX templates, then set:

- Extensions, Configure the list of force installed extensions
- Extensions, Extension management settings, only if scheduled upload is used

Third party extension configuration has no ADMX, so deliver that part as a
registry preference item using the generated `.reg` as the source.

## Verifying it applied

Restart the browser and open `edge://policy` or `chrome://policy`. The
extension should be listed as force installed, and its settings appear under
the extension id.

Inside the extension, the options page marks every policy controlled setting as
set by policy and greys it out. If a value is not showing there, it did not
apply.

## Before you deploy

Replace every `REPLACE` placeholder. The generator counts them and tells you
how many are left.

`uploadEnabled` is `false` in the example. Turning it on sends reports off the
device, so read the scheduled upload section of the main README first.

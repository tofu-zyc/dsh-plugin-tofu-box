The unmodified `winrects@cua/extension.js` and `metadata.json` are from
[trycua/cua](https://github.com/trycua/cua/tree/1c6932f4eb62a06a881edd1128adf5f33b09ce92/libs/cua-driver/wayland-helper),
tag `cua-driver-rs-v0.28.4`, commit `1c6932f4eb62a06a881edd1128adf5f33b09ce92`.
Copyright (c) 2025 Cua AI, Inc.; MIT license, reproduced in LICENSE.md.

Helper API v8 supports GNOME Shell 45–50. This helper version includes the
GNOME stage screenshot fix and is compatible with the 0.28.3 npm runtime.
The helper is bundled because the npm SDK distributes native bindings but
does not include the GNOME Shell extension shipped in the upstream CLI.

Install it explicitly with `dsh-computer-use-wayland install` (no root needed),
then log out and back in once. It supplies compositor geometry, capture and
activation. Input uses the driver's Remote Desktop portal and its system
consent dialog. Installation does not grant portal input permission.

To remove it, run `gnome-extensions disable winrects@cua`, delete only the
`winrects@cua` directory reported by the installer, and log out and back in.

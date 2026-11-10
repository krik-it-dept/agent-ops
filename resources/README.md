# Native Agent Ops assets

`icons/app.ico`, `app-light.ico`, `app-dark.ico` and their PNG pairs are the approved ledger artwork retained from the beta. The three source SVGs here are now canonical. The retired Go/web copies and generator are removed; frozen SHA-256 checks and native-resolution tests protect these assets. No artwork was redesigned.

The tiled `app.ico` is the window/taskbar icon and unknown-theme tray fallback; `app.png` is the notification icon. `app-light.ico` has dark ink for a light Windows taskbar, and `app-dark.ico` has light ink for a dark taskbar. The taskbar's `SystemUsesLightTheme` setting is read independently of the app's UI theme.

Each ICO contains 16, 24, 32, 48 and 256 pixel images. Packaging copies `resources/icons` as a unit; main passes `process.resourcesPath` to the platform services and development passes `<project>/resources`. Installer shortcuts and executable metadata use the tiled icon and AppUserModelID `KrikIT.AgentOps`.

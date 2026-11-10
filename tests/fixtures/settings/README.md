# Settings fixtures

`owner-legacy-config.json` is a made-up config.json in the shape an owner's installation has after upgrades: the
legacy `stateFile` and `slotsFile` keys, the per-client `integrations` map of v0.3.0 development builds, a Vietnamese
workspace path, a nanosecond `addedAt` written by Go and a key from a newer release. Tests copy it into a temporary
data folder; it is never a real owner's file.

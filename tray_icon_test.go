package main

import (
	"bytes"
	"errors"
	"testing"

	"github.com/krik-it-dept/agent-ops/internal/appicon"
)

func TestTaskbarIconUsesSystemThemeAndFallsBackWithoutRegistryWrites(t *testing.T) {
	for _, tc := range []struct {
		value uint64
		err   error
		want  string
	}{
		{1, nil, "app-light.ico"}, {0, nil, "app-dark.ico"}, {2, nil, "app.ico"},
		{0, errors.New("missing or unreadable value"), "app.ico"},
	} {
		if got := taskbarIconForValue(tc.value, tc.err); got != tc.want {
			t.Fatalf("%d/%v: %s", tc.value, tc.err, got)
		}
	}
	if !bytes.Equal(trayIcon("missing.ico"), trayIcon("app.ico")) {
		t.Fatal("tray fallback is missing")
	}
}

func TestEmbeddedIconsMatchSVGArtwork(t *testing.T) {
	for name, variant := range map[string]string{"app": appicon.Tile, "app-light": appicon.Light, "app-dark": appicon.Dark} {
		for _, ext := range []string{"png", "ico"} {
			data, err := iconFiles.ReadFile("web/icons/" + name + "." + ext)
			if err != nil {
				t.Fatal(err)
			}
			var want []byte
			if ext == "png" {
				want = appicon.PNG(256, variant)
			} else {
				want = appicon.ICO(variant)
			}
			if !bytes.Equal(data, want) {
				t.Fatalf("%s.%s is stale; run go run ./cmd/icon", name, ext)
			}
		}
	}
}

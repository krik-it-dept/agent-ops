// Rasterize the original ledger artwork before compiling Windows resources.
package main

import (
	"bytes"
	"debug/pe"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"os"
	"path/filepath"

	"github.com/krik-it-dept/agent-ops/internal/appicon"
)

func main() {
	executable := flag.String("verify-exe", "", "Verify native executable icons against the approved source artwork")
	previewDir := flag.String("preview-dir", "", "Also save 256/32/16px previews on white and #0a0a0a")
	flag.Parse()
	if *executable != "" {
		file, err := pe.Open(*executable)
		if err != nil {
			log.Fatal(err)
		}
		defer file.Close()
		section := file.Section(".rsrc")
		if section == nil {
			log.Fatal("executable has no native resource section")
		}
		data, err := section.Data()
		if err != nil {
			log.Fatal(err)
		}
		for _, size := range []int{16, 24, 32, 48, 256} {
			if !bytes.Contains(data, appicon.PNG(size, appicon.Tile)) {
				log.Fatalf("native %dpx icon does not match approved artwork", size)
			}
		}
		fmt.Println("Native executable icons match ledger tile artwork: 16, 24, 32, 48, 256px")
		return
	}
	for path, data := range map[string][]byte{
		"web/icons/app.png":       appicon.PNG(256, appicon.Tile),
		"web/icons/app.ico":       appicon.ICO(appicon.Tile),
		"web/icons/app-light.png": appicon.PNG(256, appicon.Light),
		"web/icons/app-dark.png":  appicon.PNG(256, appicon.Dark),
		"web/icons/app-light.ico": appicon.ICO(appicon.Light),
		"web/icons/app-dark.ico":  appicon.ICO(appicon.Dark),
	} {
		if err := os.WriteFile(path, data, 0644); err != nil {
			log.Fatal(err)
		}
	}
	if *previewDir != "" {
		previews(*previewDir)
	}
}

func previews(dir string) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Fatal(err)
	}
	for _, variant := range []string{appicon.Light, appicon.Dark, appicon.Tile} {
		for _, size := range []int{256, 32, 16} {
			src, err := png.Decode(bytes.NewReader(appicon.PNG(size, variant)))
			if err != nil {
				log.Fatal(err)
			}
			for name, bg := range map[string]color.Color{"white": color.White, "dark": color.NRGBA{R: 10, G: 10, B: 10, A: 255}} {
				img := image.NewRGBA(src.Bounds())
				draw.Draw(img, img.Bounds(), image.NewUniform(bg), image.Point{}, draw.Src)
				draw.Draw(img, img.Bounds(), src, image.Point{}, draw.Over)
				var out bytes.Buffer
				if err := png.Encode(&out, img); err != nil {
					log.Fatal(err)
				}
				path := filepath.Join(dir, fmt.Sprintf("icon-%s-%d-%s.png", variant, size, name))
				if err := os.WriteFile(path, out.Bytes(), 0644); err != nil {
					log.Fatal(err)
				}
			}
		}
	}
}

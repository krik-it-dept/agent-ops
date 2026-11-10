package appicon

import (
	"bytes"
	"encoding/binary"
	"image/color"
	"image/png"
	"testing"
)

func TestThemeMarksRetainTransparencyAndContrastAtSmallSizes(t *testing.T) {
	for _, size := range []int{16, 32, 256} {
		light, err := png.Decode(bytes.NewReader(PNG(size, Light)))
		if err != nil {
			t.Fatal(err)
		}
		dark, err := png.Decode(bytes.NewReader(PNG(size, Dark)))
		if err != nil {
			t.Fatal(err)
		}
		if light.Bounds().Dx() != size || dark.Bounds().Dy() != size {
			t.Fatal("wrong dimensions")
		}
		clear, solid, edge := 0, 0, 0
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				l := color.NRGBAModel.Convert(light.At(x, y)).(color.NRGBA)
				d := color.NRGBAModel.Convert(dark.At(x, y)).(color.NRGBA)
				if l.A != d.A {
					t.Fatalf("%dpx theme silhouettes differ at %d,%d", size, x, y)
				}
				switch l.A {
				case 0:
					clear++
				case 255:
					solid++
					if l.R != 38 || l.G != 38 || l.B != 38 || d.R != 245 || d.G != 245 || d.B != 245 {
						t.Fatal("theme contrast changed")
					}
				default:
					edge++
				}
			}
		}
		if clear < size*size/2 || solid < size*size/16 || edge == 0 {
			t.Fatalf("%dpx mark lost transparency, visible strokes or antialiasing: %d/%d/%d", size, clear, solid, edge)
		}
	}
}

func TestICOContainsEveryNativeSizeAndMatchingPNG(t *testing.T) {
	for _, variant := range []string{Light, Dark, Tile} {
		ico := ICO(variant)
		if binary.LittleEndian.Uint16(ico[2:4]) != 1 || binary.LittleEndian.Uint16(ico[4:6]) != 5 {
			t.Fatal("invalid ICO header")
		}
		for i, size := range []int{16, 24, 32, 48, 256} {
			e := ico[6+16*i : 6+16*(i+1)]
			n := int(binary.LittleEndian.Uint32(e[8:12]))
			offset := int(binary.LittleEndian.Uint32(e[12:16]))
			if int(e[0]) != size%256 || int(e[1]) != size%256 || binary.LittleEndian.Uint16(e[6:8]) != 32 || offset+n > len(ico) {
				t.Fatal("invalid native image entry")
			}
			if !bytes.Equal(ico[offset:offset+n], PNG(size, variant)) {
				t.Fatalf("%s %dpx native image is stale", variant, size)
			}
		}
	}
}

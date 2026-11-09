// Package appicon packages the supplied cobalt robot artwork for the app.
// Only the build helper decodes the full source; the tray uses the prebuilt ICO.
package appicon

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"sync"
)

//go:embed source.png
var sourcePNG []byte
var once sync.Once
var source image.Image

func artwork() image.Image {
	once.Do(func() {
		var err error
		source, err = png.Decode(bytes.NewReader(sourcePNG))
		if err != nil {
			panic("invalid bundled Workboard logo: " + err.Error())
		}
	})
	return source
}

// PNG scales the entire square artwork with an area filter, retaining its
// framing and background. The original source file is never rewritten.
func PNG(size int) []byte {
	src := artwork()
	bounds := src.Bounds()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		top := bounds.Min.Y + y*bounds.Dy()/size
		bottom := bounds.Min.Y + (y+1)*bounds.Dy()/size
		for x := 0; x < size; x++ {
			left := bounds.Min.X + x*bounds.Dx()/size
			right := bounds.Min.X + (x+1)*bounds.Dx()/size
			var r, g, b, a, count uint64
			for sy := top; sy < bottom; sy++ {
				for sx := left; sx < right; sx++ {
					rr, gg, bb, aa := src.At(sx, sy).RGBA()
					r += uint64(rr)
					g += uint64(gg)
					b += uint64(bb)
					a += uint64(aa)
					count++
				}
			}
			img.SetRGBA(x, y, color.RGBA{uint8(r / count >> 8), uint8(g / count >> 8), uint8(b / count >> 8), uint8(a / count >> 8)})
		}
	}
	var out bytes.Buffer
	_ = png.Encode(&out, img)
	return out.Bytes()
}

func ICO() []byte {
	sizes := []int{16, 24, 32, 48, 256}
	var out bytes.Buffer
	_ = binary.Write(&out, binary.LittleEndian, []uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	var images [][]byte
	for _, size := range sizes {
		data := PNG(size)
		images = append(images, data)
		out.Write([]byte{byte(size % 256), byte(size % 256), 0, 0})
		_ = binary.Write(&out, binary.LittleEndian, []uint16{1, 32})
		_ = binary.Write(&out, binary.LittleEndian, []uint32{uint32(len(data)), uint32(offset)})
		offset += len(data)
	}
	for _, data := range images {
		out.Write(data)
	}
	return out.Bytes()
}

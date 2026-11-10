// Package appicon renders the original Agent Ops ledger artwork without external tools.
package appicon

import (
	"bytes"
	"embed"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
)

//go:embed source-*.svg
var sources embed.FS

// Variant names describe the background on which a mark is used.
const (
	Light = "light"
	Dark  = "dark"
	Tile  = "tile"
)

type shape struct {
	XMLName     xml.Name
	X           float64 `xml:"x,attr"`
	Y           float64 `xml:"y,attr"`
	Width       float64 `xml:"width,attr"`
	Height      float64 `xml:"height,attr"`
	Radius      float64 `xml:"rx,attr"`
	Fill        string  `xml:"fill,attr"`
	Points      string  `xml:"points,attr"`
	Stroke      string  `xml:"stroke,attr"`
	StrokeWidth float64 `xml:"stroke-width,attr"`
	Linecap     string  `xml:"stroke-linecap,attr"`
	Linejoin    string  `xml:"stroke-linejoin,attr"`
}

func ink(hex string) color.NRGBA {
	var r, g, b uint8
	if n, err := fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b); err != nil || n != 3 {
		panic("invalid artwork color: " + hex)
	}
	return color.NRGBA{R: r, G: g, B: b, A: 255}
}

// PNG rasterizes the SVG's rounded rectangles and round polylines with 8x
// supersampling. This deliberately small SVG subset keeps builds dependency-free.
func PNG(size int, variant string) []byte {
	if size < 1 || size > 1024 {
		panic("icon size must be 1..1024")
	}
	data, err := sources.ReadFile("source-" + variant + ".svg")
	if err != nil {
		panic(err)
	}
	var svg struct {
		ViewBox string  `xml:"viewBox,attr"`
		Shapes  []shape `xml:",any"`
	}
	if err := xml.Unmarshal(data, &svg); err != nil {
		panic(err)
	}
	if svg.ViewBox != "0 0 32 32" {
		panic("artwork must use the 32px viewBox")
	}
	type layer struct {
		contains func(float64, float64) bool
		color    color.NRGBA
	}
	var layers []layer
	for _, s := range svg.Shapes {
		switch s.XMLName.Local {
		case "rect":
			layers = append(layers, layer{func(x, y float64) bool {
				if x < s.X || x > s.X+s.Width || y < s.Y || y > s.Y+s.Height {
					return false
				}
				cx := math.Max(s.X+s.Radius, math.Min(x, s.X+s.Width-s.Radius))
				cy := math.Max(s.Y+s.Radius, math.Min(y, s.Y+s.Height-s.Radius))
				return math.Hypot(x-cx, y-cy) <= s.Radius
			}, ink(s.Fill)})
		case "polyline":
			if s.Linecap != "round" || s.Linejoin != "round" || s.Fill != "none" {
				panic("only round unfilled polylines are supported")
			}
			var x1, y1, x2, y2, x3, y3 float64
			if n, err := fmt.Sscanf(s.Points, "%f,%f %f,%f %f,%f", &x1, &y1, &x2, &y2, &x3, &y3); err != nil || n != 6 {
				panic("artwork check needs three points")
			}
			layers = append(layers, layer{func(x, y float64) bool {
				return math.Min(segmentDistance(x, y, x1, y1, x2, y2), segmentDistance(x, y, x2, y2, x3, y3)) <= s.StrokeWidth/2
			}, ink(s.Stroke)})
		default:
			panic("unsupported artwork element: " + s.XMLName.Local)
		}
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	const samples = 8
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a uint32
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					px := (float64(x) + (float64(sx)+.5)/samples) * 32 / float64(size)
					py := (float64(y) + (float64(sy)+.5)/samples) * 32 / float64(size)
					var c color.NRGBA
					for _, l := range layers {
						if l.contains(px, py) {
							c = l.color
						}
					}
					r += uint32(c.R)
					g += uint32(c.G)
					b += uint32(c.B)
					a += uint32(c.A)
				}
			}
			img.SetRGBA(x, y, color.RGBA{R: uint8(r / 64), G: uint8(g / 64), B: uint8(b / 64), A: uint8(a / 64)})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		panic(err)
	}
	return out.Bytes()
}

func segmentDistance(x, y, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	t := math.Max(0, math.Min(1, ((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)))
	return math.Hypot(x-ax-t*dx, y-ay-t*dy)
}

func ICO(variant string) []byte {
	sizes := []int{16, 24, 32, 48, 256}
	var out bytes.Buffer
	_ = binary.Write(&out, binary.LittleEndian, []uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	var images [][]byte
	for _, size := range sizes {
		data := PNG(size, variant)
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

// Command manifest writes the update package manifest for a built package
// directory. scripts/build.ps1 runs it; the release publishes the result as the
// agent-ops-windows-amd64.manifest.json asset.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
)

func main() {
	dir := flag.String("dir", "", "Unpacked package directory")
	version := flag.String("version", "", "Release version")
	remove := flag.String("remove", "", "Comma-separated runtime paths the update deletes")
	out := flag.String("o", "", "Output file")
	flag.Parse()
	if *dir == "" || *version == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: manifest -dir <package> -version <vX.Y.Z> [-remove a,b] -o <file>")
		os.Exit(2)
	}
	var removed []string
	for _, r := range strings.Split(*remove, ",") {
		if r = strings.TrimSpace(r); r != "" {
			removed = append(removed, r)
		}
	}
	m, err := pkgmanifest.Generate(*dir, *version, removed)
	if err != nil {
		fmt.Fprintln(os.Stderr, "manifest:", err)
		os.Exit(1)
	}
	b, err := pkgmanifest.Marshal(m)
	if err == nil {
		err = os.WriteFile(*out, b, 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "manifest:", err)
		os.Exit(1)
	}
	fmt.Printf("Manifest: %s (%d files, %d removed)\n", *out, len(m.Files), len(m.Remove))
}

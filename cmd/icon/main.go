// Package the supplied logo before compiling Windows executable resources.
package main

import (
	"bytes"
	"debug/pe"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/krik-it-dept/agent-ops/internal/appicon"
)

func main() {
	executable := flag.String("verify-exe", "", "Verify native executable icons against the approved source artwork")
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
			if !bytes.Contains(data, appicon.PNG(size)) {
				log.Fatalf("native %dpx icon does not match approved artwork", size)
			}
		}
		fmt.Println("Native executable icons match approved artwork: 16, 24, 32, 48, 256px")
		return
	}
	for path, data := range map[string][]byte{"web/icons/app.png": appicon.PNG(256), "web/icons/app.ico": appicon.ICO()} {
		if err := os.WriteFile(path, data, 0644); err != nil {
			log.Fatal(err)
		}
	}
}

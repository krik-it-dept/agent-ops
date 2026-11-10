package main

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

// Project IDs and repository names key every plan, so Go and plan-reader.mjs must
// compute the same values, including for drive and network-share roots.
func TestGoAndNodeAgreeOnProjectIDsAndRepoNames(t *testing.T) {
	paths := []string{`D:\`, `d:\Work\Repos\`, `D:\Work\Repos`, `\\server\share`, `\\server\share\`, `\\server\share\team\`, `C:\Dự Án\web`}
	reader, _ := filepath.Abs("plan-reader.mjs")
	script := `const {projectIdFor,repoNameOf}=await import(process.argv[1]);` +
		`process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(p=>[projectIdFor(p),repoNameOf(p)])))`
	input, _ := json.Marshal(paths)
	out, err := exec.Command("node", "--input-type=module", "-e", script, "file:///"+filepath.ToSlash(reader), string(input)).Output()
	if err != nil {
		t.Fatal(err)
	}
	var node [][2]string
	if err := json.Unmarshal(out, &node); err != nil {
		t.Fatal(err, string(out))
	}
	for i, p := range paths {
		if goSide := [2]string{projectIDFor(p), repoNameOf(p)}; goSide != node[i] {
			t.Errorf("%s: Go %v, Node %v", p, goSide, node[i])
		}
		if repoNameOf(p) == "" {
			t.Errorf("%s has an empty repository name", p)
		}
	}
	if projectIDFor(`\\server\share`) != projectIDFor(`\\server\share\`) {
		t.Error("a share root with and without a trailing separator must have one ID")
	}
	if repoNameOf(`D:\`) != "D" || repoNameOf(`\\server\share\`) != "share" {
		t.Error("root repository names", repoNameOf(`D:\`), repoNameOf(`\\server\share\`))
	}
}

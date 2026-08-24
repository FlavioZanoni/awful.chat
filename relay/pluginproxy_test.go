package main

import "testing"

func TestSubstituteSecrets(t *testing.T) {
	secrets := map[string]string{"STEAM": "k&y 123"}
	out, err := substituteSecrets("https://x/?key={{secret:steam}}&id=7", secrets)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://x/?key=k%26y+123&id=7"
	if out != want {
		t.Errorf("got %q want %q", out, want)
	}
	if _, err := substituteSecrets("https://x/?key={{secret:missing}}", secrets); err == nil {
		t.Error("missing secret must error")
	}
	// No placeholders passes through untouched.
	if out, _ := substituteSecrets("https://x/plain", secrets); out != "https://x/plain" {
		t.Errorf("plain url mangled: %q", out)
	}
}

func TestPluginProxyEnvParsing(t *testing.T) {
	t.Setenv("PLUGIN_PROXY_HOSTS", "api.steampowered.com, Other.API ,")
	hosts := pluginProxyHosts()
	if !hosts["api.steampowered.com"] || !hosts["other.api"] || len(hosts) != 2 {
		t.Errorf("hosts parsed wrong: %v", hosts)
	}
	t.Setenv("PLUGIN_PROXY_SECRETS", "steam=abc, FOO=a=b,")
	secrets := pluginProxySecrets()
	if secrets["STEAM"] != "abc" || secrets["FOO"] != "a=b" || len(secrets) != 2 {
		t.Errorf("secrets parsed wrong: %v", secrets)
	}
}

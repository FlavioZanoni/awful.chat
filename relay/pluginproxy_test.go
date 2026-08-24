package main

import "testing"

func TestSubstituteSecrets(t *testing.T) {
	secrets := map[string]pluginSecret{
		"STEAM": {value: "k&y 123", host: "api.steampowered.com"},
		"OPEN":  {value: "free"},
	}
	out, err := substituteSecrets("https://x/?key={{secret:steam}}&id=7", secrets, "api.steampowered.com")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://x/?key=k%26y+123&id=7"
	if out != want {
		t.Errorf("got %q want %q", out, want)
	}
	// A bound secret must NOT substitute for another host - this is the
	// cross-host leakage the review flagged.
	if _, err := substituteSecrets("https://x/?k={{secret:steam}}", secrets, "evil.example"); err == nil {
		t.Error("host-bound secret leaked to another host")
	}
	// An unbound secret works for any host.
	if out, err := substituteSecrets("https://x/?k={{secret:open}}", secrets, "evil.example"); err != nil || out != "https://x/?k=free" {
		t.Errorf("unbound secret: %q %v", out, err)
	}
	if _, err := substituteSecrets("https://x/?key={{secret:missing}}", secrets, "h"); err == nil {
		t.Error("missing secret must error")
	}
	if out, _ := substituteSecrets("https://x/plain", secrets, "h"); out != "https://x/plain" {
		t.Errorf("plain url mangled: %q", out)
	}
}

func TestPluginProxyRateLimit(t *testing.T) {
	ip := "203.0.113.9"
	for i := 0; i < pluginProxyRateLimit; i++ {
		if !pluginProxyAllow(ip) {
			t.Fatalf("request %d refused inside the window", i)
		}
	}
	if pluginProxyAllow(ip) {
		t.Error("request over the limit allowed")
	}
	if !pluginProxyAllow("203.0.113.10") {
		t.Error("another client caught by the first client's bucket")
	}
}

func TestPluginProxyEnvParsing(t *testing.T) {
	t.Setenv("PLUGIN_PROXY_HOSTS", "api.steampowered.com, Other.API ,")
	hosts := pluginProxyHosts()
	if !hosts["api.steampowered.com"] || !hosts["other.api"] || len(hosts) != 2 {
		t.Errorf("hosts parsed wrong: %v", hosts)
	}
	t.Setenv("PLUGIN_PROXY_SECRETS", "steam@API.Steampowered.com=abc, FOO=a=b,")
	secrets := pluginProxySecrets()
	if secrets["STEAM"].value != "abc" || secrets["STEAM"].host != "api.steampowered.com" {
		t.Errorf("bound secret parsed wrong: %+v", secrets["STEAM"])
	}
	if secrets["FOO"].value != "a=b" || secrets["FOO"].host != "" || len(secrets) != 2 {
		t.Errorf("secrets parsed wrong: %v", secrets)
	}
}

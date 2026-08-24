package main

import "testing"

func TestParseSteamQuery(t *testing.T) {
	cases := []struct {
		in, id, vanity string
	}{
		{"76561198000000000", "76561198000000000", ""},
		{"gaben", "", "gaben"},
		{"https://steamcommunity.com/profiles/76561198000000000", "76561198000000000", ""},
		{"https://steamcommunity.com/profiles/76561198000000000/", "76561198000000000", ""},
		{"https://steamcommunity.com/id/gaben", "", "gaben"},
		{"https://steamcommunity.com/id/gaben/games", "", "gaben"},
		{"  gaben  ", "", "gaben"},
		{"https://evil.com/profiles/76561198000000000", "76561198000000000", ""},
		{"not a profile at all!!!", "", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		id, vanity := parseSteamQuery(c.in)
		if id != c.id || vanity != c.vanity {
			t.Errorf("parseSteamQuery(%q) = (%q,%q), want (%q,%q)", c.in, id, vanity, c.id, c.vanity)
		}
	}
}

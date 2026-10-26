package cli

import "testing"

func TestFlagTrailingIsAbsent(t *testing.T) {
	if _, ok := Flag([]string{"x", "/tmp", "--priority"}, "priority"); ok {
		t.Fatal("trailing flag must read as absent")
	}
	if v, ok := Flag([]string{"--asks", "--no-aice"}, "asks"); !ok || v != "--no-aice" {
		t.Fatalf("got %q %v", v, ok)
	}
	if v, _ := Flag([]string{"--a", "1", "--a", "2"}, "a"); v != "1" {
		t.Fatal("first occurrence wins")
	}
	_, err := RequiredFlag([]string{"--ssh", "--cwd", "/x"}, "ssh", "USAGE")
	if err == nil || err.Error() != "--ssh is required\nUSAGE" {
		t.Fatalf("got %v", err)
	}
	if v, err := RequiredFlag([]string{"--ssh", "box"}, "ssh", "USAGE"); err != nil || v != "box" {
		t.Fatalf("got %q %v", v, err)
	}
}

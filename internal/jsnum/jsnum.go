// Package jsnum reproduces JavaScript's number formatting and rounding, oddities included.
package jsnum

import (
	"fmt"
	"math"
	"math/big"
	"strings"
	"unicode/utf16"
)

// ToFixed is Number.prototype.toFixed: it rounds the exact binary value half-up,
// where %.Nf rounds half-even and so disagrees on exact ties like 0.125.
func ToFixed(v float64, digits int) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	}
	if digits < 0 || digits > 20 || math.Abs(v) >= 1e21 {
		panic(fmt.Sprintf("jsnum: ToFixed(%v, %d) outside the supported range", v, digits))
	}
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)
	x := new(big.Rat).SetFloat64(math.Abs(v))
	x.Mul(x, new(big.Rat).SetInt(scale))
	x.Add(x, big.NewRat(1, 2))
	n := new(big.Int).Quo(x.Num(), x.Denom()) // non-negative, so Quo is floor
	s := n.String()
	if len(s) <= digits {
		s = strings.Repeat("0", digits-len(s)+1) + s
	}
	if digits > 0 {
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if v < 0 {
		s = "-" + s
	}
	return s
}

func Round4(v float64) float64 { return RoundHalfUp(v*10000) / 10000 }

// RoundHalfUp is Math.round: ties go toward +Infinity, so -2.5 -> -2.
func RoundHalfUp(v float64) float64 { return math.Floor(v + 0.5) }

// Slice is String.prototype.slice(0, n): the first n UTF-16 code units, so a length cap
// agrees with the TS one on non-ASCII text. Deviation: a cut through a surrogate pair leaves
// JS holding a lone high surrogate, which a Go string cannot carry as text; it is dropped
// here, so the Go result is one unit shorter in exactly that case.
func Slice(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if n >= len(u) {
		return s
	}
	if n > 0 && utf16.IsSurrogate(rune(u[n-1])) && u[n-1] < 0xdc00 {
		n--
	}
	return string(utf16.Decode(u[:max(n, 0)]))
}

// Package jsnum reproduces JavaScript's number formatting and rounding, oddities included.
package jsnum

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
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

// String is Number.prototype.toString, which JSON.stringify uses: plain digits for
// 1e-6 <= |v| < 1e21, exponent form outside it with no zero-padded exponent ("1e-7", not Go's "1e-07").
func String(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	case v == 0:
		return "0"
	}
	if a := math.Abs(v); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	s := strconv.FormatFloat(v, 'e', -1, 64)
	mant, exp, _ := strings.Cut(s, "e")
	sign, digits := exp[:1], strings.TrimLeft(exp[1:], "0")
	return mant + "e" + sign + digits
}

var (
	intPrefix   = regexp.MustCompile(`^\s*[+-]?\d+`)
	floatPrefix = regexp.MustCompile(`^\s*[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)`)
)

// ParseInt is Number.parseInt(s, 10): ok is false where JS answers NaN.
func ParseInt(s string) (float64, bool) {
	return parsePrefix(intPrefix, s)
}

// ParseFloat is Number.parseFloat: the longest decimal-literal prefix, ok false for NaN.
func ParseFloat(s string) (float64, bool) {
	return parsePrefix(floatPrefix, s)
}

func parsePrefix(re *regexp.Regexp, s string) (float64, bool) {
	m := strings.TrimSpace(re.FindString(s))
	if m == "" {
		return 0, false
	}
	// strconv accepts "Infinity" case-insensitively and a signed form; an out-of-range
	// literal returns +-Inf with a range error, which is what JS yields too.
	v, err := strconv.ParseFloat(m, 64)
	if err != nil && !math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

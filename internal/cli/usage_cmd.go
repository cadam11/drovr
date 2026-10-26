package cli

import (
	"fmt"
	"math"
	"strconv"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/usage"
)

const usageNote = "yours = total account usage minus what drovr's own ledger accounts for, in " +
	"account-units (N usable accounts = N.0). peakFraction is that peak as a share of " +
	"the pool, directly comparable to configuredReserve. Sampled once per tick; " +
	"nothing here feeds an admission decision."

var usageBuckets = []control.Bucket{"fable", "general", "session"}

type usageRow struct {
	bucket   control.Bucket
	latest   *usage.Share
	observed *usage.Observed
}

// rounded is Number(x.toFixed(3)): a pointer so a missing reading encodes as null.
func rounded(v *float64) *float64 {
	if v == nil {
		return nil
	}
	f, err := strconv.ParseFloat(jsnum.ToFixed(*v, 3), 64)
	if err != nil {
		panic("usage: toFixed did not return a number: " + err.Error())
	}
	return &f
}

func usageRows(samples []usage.Sample, cycles []ledger.Cycle) []usageRow {
	rows := make([]usageRow, 0, len(usageBuckets))
	for _, b := range usageBuckets {
		row := usageRow{bucket: b, observed: usage.ObservedYours(samples, cycles, b, 0.9, 24)}
		if len(samples) > 0 {
			s := usage.ShareOf(samples[len(samples)-1], cycles, b)
			row.latest = &s
		}
		rows = append(rows, row)
	}
	return rows
}

func usageJSON(c control.Control, samples []usage.Sample, rows []usageRow, reserve *float64) any {
	type bucketJSON struct {
		Bucket       control.Bucket `json:"bucket"`
		YoursNow     *float64       `json:"yoursNow"`
		DrovrNow     *float64       `json:"drovrNow"`
		TotalNow     *float64       `json:"totalNow"`
		PeakP90      *float64       `json:"observedPeakP90"`
		PeakFraction *float64       `json:"observedPeakFractionP90"`
	}
	buckets := make([]bucketJSON, 0, len(rows))
	for _, r := range rows {
		b := bucketJSON{Bucket: r.bucket}
		if r.latest != nil {
			b.YoursNow, b.DrovrNow, b.TotalNow = rounded(&r.latest.Yours), rounded(&r.latest.Drovr), rounded(&r.latest.Total)
		}
		if r.observed != nil {
			b.PeakP90, b.PeakFraction = rounded(&r.observed.Peak), rounded(&r.observed.PeakFraction)
		}
		buckets = append(buckets, b)
	}
	var first, last *string
	if len(samples) > 0 {
		first, last = &samples[0].At, &samples[len(samples)-1].At
	}
	return struct {
		Note    string       `json:"note"`
		Samples int          `json:"samples"`
		First   *string      `json:"firstSampleAt"`
		Last    *string      `json:"lastSampleAt"`
		Mode    control.Mode `json:"mode"`
		Reserve *float64     `json:"configuredReserve"`
		Buckets []bucketJSON `json:"buckets"`
	}{usageNote, len(samples), first, last, c.Mode, reserve, buckets}
}

func dash(v *float64, text func(float64) string) string {
	if v == nil {
		return "—"
	}
	return text(*v)
}

func pct(v float64) string { return jsnum.ToFixed(v*100, 0) + "%" }

func usageTable(cli Env, rows []usageRow) {
	two := func(v float64) string { return jsnum.ToFixed(v, 2) }
	fmt.Fprintln(cli.Stdout, "bucket    yours now  drovr now   your p90 peak   as % of pool")
	for _, r := range rows {
		var yours, drovr, peak, share *float64
		if r.latest != nil {
			yours, drovr = &r.latest.Yours, &r.latest.Drovr
		}
		if r.observed != nil {
			peak, share = &r.observed.Peak, &r.observed.PeakFraction
		}
		fmt.Fprintf(cli.Stdout, "%s %s %s %s %s\n", padEnd(string(r.bucket), 9), padStart(dash(yours, two), 9),
			padStart(dash(drovr, two), 10), padStart(dash(peak, two), 15), padStart(dash(share, pct), 14))
	}
}

// usageVerdict is the closing paragraph on the general bucket's observation. The "Widen it
// with" figure is a fraction, though `reserve` reads a percent: the TS quirk, ported as is.
func usageVerdict(cli Env, rows []usageRow, reserve *float64) {
	var weekly *usage.Observed
	for _, r := range rows {
		if r.bucket == "general" {
			weekly = r.observed
		}
	}
	if weekly == nil {
		fmt.Fprintln(cli.Stdout, "\nNot enough samples yet to say whether the reserve is sized for you.")
		return
	}
	if reserve == nil {
		return
	}
	pf, held := pct(weekly.PeakFraction), pct(*reserve)
	if weekly.PeakFraction > *reserve {
		widen := jsnum.ToFixed(math.Min(0.95, math.Ceil(weekly.PeakFraction*20)/20), 2)
		fmt.Fprintf(cli.Stdout, "\nYour own weekly p90 (%s) is above the %s held for you — the reserve is under-sized for how you actually use the pool. Widen it with \"drovr reserve %s\".\n", pf, held, widen)
		return
	}
	fmt.Fprintf(cli.Stdout, "\nYour own weekly p90 (%s) fits inside the %s held for you — the reserve covers you as configured.\n", pf, held)
}

// Usage reports how much of the pool the operator's own sessions take, read from samples.
func Usage(env Env, _ []string, asJSON bool) error {
	samples, err := usage.ReadSamples(env.Paths.Usage)
	if err != nil {
		return err
	}
	cycles, err := ledger.ReadCycles(env.Paths.Cycles)
	if err != nil {
		return err
	}
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	var reserve *float64
	if ceiling, ok, err := control.CeilingsFor(c); err != nil {
		return err
	} else if ok {
		r := 1 - ceiling.Weekly
		reserve = &r
	}
	rows := usageRows(samples, cycles)
	if asJSON {
		return encodeJSON(env.Stdout, usageJSON(c, samples, rows, reserve))
	}
	if len(samples) == 0 {
		fmt.Fprintln(env.Stdout, "no usage samples yet — the tick records one per firing, so give it a tick.")
		return nil
	}
	fmt.Fprintf(env.Stdout, "%d samples, %s to %s\n", len(samples), jsnum.Slice(samples[0].At, 16), jsnum.Slice(samples[len(samples)-1].At, 16))
	held := ""
	if reserve != nil {
		held = ", reserve held for you " + pct(*reserve)
	}
	fmt.Fprintf(env.Stdout, "mode %s%s\n\n", c.Mode, held)
	usageTable(env, rows)
	usageVerdict(env, rows, reserve)
	return nil
}

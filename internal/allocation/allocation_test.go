package allocation

import (
	"encoding/json"
	"testing"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

func TestSegmentsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "allocationSegments") {
		var wrap struct {
			Input struct {
				Status        json.RawMessage `json:"status"`
				Pool          capacity.Pool   `json:"pool"`
				Cycles        []ledger.Cycle  `json:"cycles"`
				RunningCycles int             `json:"runningCycles"`
				CycleCost     ledger.Cost     `json:"cycleCost"`
				Now           epoch.Millis    `json:"now"`
			} `json:"input"`
		}
		if err := json.Unmarshal(c.Input, &wrap); err != nil {
			t.Fatal(err)
		}
		in := wrap.Input
		s, err := teamclaude.Parse(in.Status)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, SegmentsFor(s, in.Pool, in.Cycles, in.RunningCycles, in.CycleCost, in.Now), c.Output)
	}
}

func TestSegmentsSumToTotal(t *testing.T) {
	a := For(Input{Pool: capacity.Pool{UsableAccounts: 2, Fable: 0.9}, Bucket: "fable", SpentByPrograms: 0.3, RunningCycles: 1, CycleCost: ledger.Cost{Fable: 0.2}})
	sum := a.YoursSpent + a.ProgramsSpent + a.ProgramsReserved + a.ProgramsAvailable + a.YoursReserved
	if sum < a.Total-1e-9 || sum > a.Total+1e-9 {
		t.Fatalf("segments sum %v total %v", sum, a.Total)
	}
}

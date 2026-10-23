package hey

import (
	"context"
	"time"
)

// Copied from the hey repo's wait_test.go, main.go and args.go, which drovr does not copy whole:
// the copied hey_http_test.go needs all three.
type fakeClock struct{ at time.Time }

func (c *fakeClock) now() time.Time { return c.at }

func (c *fakeClock) sleep(ctx context.Context, d time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	c.at = c.at.Add(d)
	return nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func ptr[T any](v T) *T { return &v }

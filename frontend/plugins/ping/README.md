# Ping

Measures the round trip to up to three people in the room and graphs it live.

```
/ping @alice, @bob, @carol
```

## What it measures

The probe is answered on the peer's receive path, before signing, the
reducer or any rendering. So this is the latency of the connection, not of
the application - which is the useful half. A fast ping alongside laggy chat
points at the relay or the message pipeline rather than at the link.

Round trips are point to point, so the numbers belong to whoever ran the
command. Only they probe; everyone else in the room sees the summary once
the window closes. Publishing every sample would be sixty messages per peer.

## Why 500ms

There is a floor and a ceiling.

The **floor** is the round trip itself. Probe faster than the reply comes
back and several are in flight at once: you add traffic to the link whose
congestion you are measuring, so you become part of the answer, and the
samples stop being independent - one queueing event smears across several
probes and a single bad moment reads as many.

The **ceiling** is how fast the thing being measured changes. A wifi
retransmit, a buffer filling, a handover live on the scale of a few hundred
milliseconds. Sample much slower and you alias: unrelated snapshots instead
of a picture of one condition.

P2P round trips run 10-150ms, so 500ms clears twice the round trip for
anything up to 250ms while still landing around sixty samples in the
30-second window. The cadence then backs off to twice the measured round
trip when a link struggles, for the same reason TCP grows its retransmission
timeout: a link in trouble wants fewer probes, not a fixed drumbeat.

## Why min / median / max and not an average

On a spotty link the mean is the one statistic that hides the problem: a
handful of 800ms spikes among fast replies averages out to "fine". The
median says what it is usually like, the max says how bad it gets.

A probe that never answers is counted as loss, never as latency. Folding a
timeout in as a number would drag the median and blow out the scale of the
graph.

Peers reached through a relay are labelled. That hop is peer to relay to
peer, so it is structurally slower, and without saying so the graph looks
like somebody's connection is bad when the real answer is that the two of
you never managed a direct one.

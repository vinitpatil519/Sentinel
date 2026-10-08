/*
 * CSI capture, and the traffic that makes it happen.
 *
 * The part that surprises people: a station receives CSI only when it receives a
 * frame. An idle node on a quiet network produces almost no CSI, so respiration
 * — which needs an evenly sampled series at ~10 Hz — cannot be recovered from it.
 *
 * The fix used here is the standard one: the node deliberately generates traffic.
 * It sends a tiny UDP datagram to the sensing host at `poke_hz`, and the access
 * point's link-layer ACK for each of those transmissions is a received frame with
 * CSI attached (`dump_ack_en`). One poke in, one CSI sample out, at a rate we
 * choose rather than one the network happens to provide.
 *
 * `poke_hz` is therefore the *sampling* rate and must stay comfortably above the
 * report rate (default 100 Hz poke, 10 Hz report). Oversampling then decimating
 * is intentional: the newest complete CSI buffer is published each report tick,
 * so a lost ACK costs nothing, and the backend resamples onto a uniform grid
 * regardless.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "csi_frame.h"

typedef struct {
    int8_t iq[CSI_FRAME_MAX_IQ_BYTES];
    size_t iq_len;
    uint16_t n_subcarriers;
    uint8_t n_antennas;
    int8_t rssi;
    int8_t noise_floor;
    uint8_t channel;
    uint8_t ppdu_type;
    uint32_t captured_count;   /* monotonic count of callbacks served */
    bool valid;
} csi_sample_t;

/* Install the CSI callback and enable capture. Call after the WiFi link is up. */
bool csi_capture_start(void);

/*
 * Copy the most recent sample. Returns false when no CSI has arrived yet, which
 * is a real state to report rather than paper over: it means the link is up but
 * the radio is seeing nothing, and the node should say so.
 */
bool csi_capture_latest(csi_sample_t *out);

/* Total callbacks served since boot, and those dropped for being oversized. */
uint32_t csi_capture_count(void);
uint32_t csi_capture_dropped(void);

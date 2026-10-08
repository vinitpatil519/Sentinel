/*
 * ADR-018 CSI frame: the wire format between a node and the sensing server.
 *
 * Byte layout, little-endian throughout. This is not ours — it is what the
 * RuView sensing server's parser reads (`crates/wifi-densepose-sensing-server/
 * src/csi.rs::parse_esp32_frame`), reproduced here so a node built from this
 * source is a drop-in for one running the upstream binary:
 *
 *   off  size  field
 *   0    4     magic = 0xC5110001
 *   4    1     node_id
 *   5    1     n_antennas
 *   6    2     n_subcarriers          (u16 — a single byte here truncates an
 *                                      ESP32-C6 HE frame's 256 to 0)
 *   8    4     freq_mhz               (u32, though values fit a u16)
 *   12   4     sequence
 *   16   1     rssi       (i8, negative dBm)
 *   17   1     noise_floor (i8)
 *   18   1     ppdu_type  (0 = HT/legacy, 1 = HE)
 *   19   1     flags
 *   20   ..    int8 I/Q pairs, n_antennas * n_subcarriers of them
 *
 * The I/Q bytes are copied verbatim out of the ESP-IDF CSI buffer. ESP-IDF
 * documents that buffer as pairs of (imaginary, real); the server computes
 * sqrt(a^2 + b^2), which is invariant to that ordering, and SENTINEL's own
 * respiration chain uses only amplitude. Phase sign would flip if anything
 * downstream started using it — noted here rather than silently assumed.
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CSI_FRAME_MAGIC 0xC5110001u
#define CSI_FRAME_HEADER_LEN 20
/* HT20 with LTF merge yields 64 subcarriers (128 bytes); an ESP32-C6 HE-SU frame
 * can yield 256. The buffer is sized for the worst case with two antennas. */
#define CSI_FRAME_MAX_IQ_BYTES 1024
#define CSI_FRAME_MAX_LEN (CSI_FRAME_HEADER_LEN + CSI_FRAME_MAX_IQ_BYTES)

#define CSI_PPDU_HT_LEGACY 0
#define CSI_PPDU_HE 1

typedef struct {
    uint8_t node_id;
    uint8_t n_antennas;
    uint16_t n_subcarriers;
    uint32_t freq_mhz;
    uint32_t sequence;
    int8_t rssi;
    int8_t noise_floor;
    uint8_t ppdu_type;
    uint8_t flags;
    const int8_t *iq;   /* n_antennas * n_subcarriers * 2 bytes */
    size_t iq_len;
} csi_frame_t;

/*
 * Serialise into `out` (at least CSI_FRAME_MAX_LEN bytes). Returns the number of
 * bytes written, or 0 if the frame does not fit or is inconsistent — a truncated
 * frame is worse than no frame, because the server would parse it as a valid
 * capture with the wrong subcarrier count.
 */
size_t csi_frame_pack(const csi_frame_t *frame, uint8_t *out, size_t out_len);

/* Channel number (1-14) to centre frequency in MHz, 2.4 GHz band. */
uint32_t csi_frame_channel_to_mhz(uint8_t channel);

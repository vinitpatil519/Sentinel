#include "csi_frame.h"

#include <string.h>

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

size_t csi_frame_pack(const csi_frame_t *frame, uint8_t *out, size_t out_len)
{
    if (frame == NULL || out == NULL || frame->iq == NULL) {
        return 0;
    }
    /* The declared geometry must match the payload exactly. A mismatch here is
     * how a node ends up reporting confident CSI for subcarriers it never
     * sampled. */
    const size_t declared = (size_t)frame->n_antennas * (size_t)frame->n_subcarriers * 2u;
    if (declared == 0 || declared != frame->iq_len) {
        return 0;
    }
    const size_t total = CSI_FRAME_HEADER_LEN + frame->iq_len;
    if (total > out_len || frame->iq_len > CSI_FRAME_MAX_IQ_BYTES) {
        return 0;
    }

    put_u32(out + 0, CSI_FRAME_MAGIC);
    out[4] = frame->node_id;
    out[5] = frame->n_antennas;
    put_u16(out + 6, frame->n_subcarriers);
    put_u32(out + 8, frame->freq_mhz);
    put_u32(out + 12, frame->sequence);
    out[16] = (uint8_t)frame->rssi;
    out[17] = (uint8_t)frame->noise_floor;
    out[18] = frame->ppdu_type;
    out[19] = frame->flags;
    memcpy(out + CSI_FRAME_HEADER_LEN, frame->iq, frame->iq_len);
    return total;
}

uint32_t csi_frame_channel_to_mhz(uint8_t channel)
{
    if (channel == 0) {
        return 0;
    }
    if (channel >= 14) {
        return 2484; /* channel 14 is the odd one out */
    }
    return 2407u + (uint32_t)channel * 5u;
}

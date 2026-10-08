#include "csi_capture.h"

#include <string.h>

#include "esp_log.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "csi";

static csi_sample_t s_latest;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_count;
static uint32_t s_dropped;

/*
 * Runs in the WiFi task. Must be short and must not block: anything slow here
 * stalls the radio and shows up as missing CSI, which is indistinguishable
 * downstream from a subject who left the room.
 */
static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    (void)ctx;
    if (info == NULL || info->buf == NULL || info->len <= 0) {
        return;
    }
    if ((size_t)info->len > CSI_FRAME_MAX_IQ_BYTES) {
        s_dropped++;
        return;
    }

    portENTER_CRITICAL(&s_lock);
    memcpy(s_latest.iq, info->buf, (size_t)info->len);
    s_latest.iq_len = (size_t)info->len;
    /* Two int8 values (one I/Q pair) per subcarrier. */
    s_latest.n_subcarriers = (uint16_t)(info->len / 2);
    s_latest.n_antennas = 1;
    s_latest.rssi = info->rx_ctrl.rssi;
    s_latest.noise_floor = (int8_t)info->rx_ctrl.noise_floor;
    s_latest.channel = info->rx_ctrl.channel;
#if defined(CONFIG_SOC_WIFI_HE_SUPPORT)
    /* ESP32-C6 and later distinguish HE-LTF captures; the symbol grids are not
     * comparable bin-for-bin, and the server keys its rolling windows on this. */
    s_latest.ppdu_type = (info->rx_ctrl.sig_mode == 3) ? CSI_PPDU_HE : CSI_PPDU_HT_LEGACY;
#else
    s_latest.ppdu_type = CSI_PPDU_HT_LEGACY;
#endif
    s_latest.captured_count = ++s_count;
    s_latest.valid = true;
    portEXIT_CRITICAL(&s_lock);
}

bool csi_capture_start(void)
{
    memset(&s_latest, 0, sizeof(s_latest));

    /*
     * Capture configuration. The two settings that matter most:
     *
     *  - `dump_ack_en`: CSI from the ACKs to our own transmissions. This is what
     *    turns the poke traffic into a controlled sampling clock.
     *  - `ltf_merge_en` with `channel_filter_en`: merge the LTF fields and drop
     *    out-of-band subcarriers, giving one clean amplitude vector per frame
     *    instead of several partially-populated ones.
     *
     * `manu_scale` is left off so the hardware's automatic gain applies. Manual
     * scaling would need a per-deployment shift, and an amplitude series with an
     * unknown scale factor is exactly what the quiet-floor normalisation in the
     * backend is built to tolerate.
     */
#if defined(CONFIG_SOC_WIFI_HE_SUPPORT)
    /* IDF 5.2+ on HE-capable parts (C6) takes per-PPDU acquire configs. */
    wifi_csi_acquire_config_t acquire = {
        .acquire_csi_legacy = true,
        .acquire_csi_ht20 = true,
        .acquire_csi_ht40 = true,
        .acquire_csi_su = true,
        .acquire_csi_mu = false,
        .acquire_csi_dcm = false,
        .acquire_csi_beamformed = false,
    };
    wifi_csi_config_t csi_config = {
        .enable = true,
        .acquire_csi = acquire,
        .val_scale_cfg = 0,
        .dump_ack_en = true,
    };
#else
    wifi_csi_config_t csi_config = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = true,
        .manu_scale = false,
        .shift = 0,
        .dump_ack_en = true,
    };
#endif

    esp_err_t err = esp_wifi_set_csi_config(&csi_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_config: %s", esp_err_to_name(err));
        return false;
    }
    err = esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_rx_cb: %s", esp_err_to_name(err));
        return false;
    }
    err = esp_wifi_set_csi(true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "CSI capture enabled (ACK dump on)");
    return true;
}

bool csi_capture_latest(csi_sample_t *out)
{
    if (out == NULL) {
        return false;
    }
    bool ok;
    portENTER_CRITICAL(&s_lock);
    ok = s_latest.valid;
    if (ok) {
        memcpy(out, &s_latest, sizeof(*out));
    }
    portEXIT_CRITICAL(&s_lock);
    return ok;
}

uint32_t csi_capture_count(void)
{
    return s_count;
}

uint32_t csi_capture_dropped(void)
{
    return s_dropped;
}

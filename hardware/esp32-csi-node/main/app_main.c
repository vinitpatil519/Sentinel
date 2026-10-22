/*
 * SENTINEL CSI node — ESP32-S3.
 *
 * One binary for every node; identity and network come from NVS (see
 * node_config.h). Three tasks:
 *
 *   poke      requests ICMP echo replies at poke_hz. Incoming reply data
 *             frames provide CSI samples even when link-layer ACKs do not.
 *   report    packs the newest CSI buffer into an ADR-018 frame at report_hz
 *             and sends it to the sensing host.
 *   console   a serial provisioning shell, always available.
 *
 * The node is deliberately dumb: no filtering, no averaging, no presence
 * decisions on-device. Everything that interprets the signal lives in the
 * backend where it can be versioned, tested and re-run against recordings. A
 * node that made decisions would make them unreproducibly, in a room, once.
 */

#include <stdio.h>
#include <string.h>

#include "csi_capture.h"
#include "csi_frame.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "ping/ping_sock.h"
#include "node_config.h"
#include "nvs_flash.h"
#include "wifi_link.h"

static const char *TAG = "sentinel";

#define STATUS_PERIOD_MS 10000

static node_config_t s_cfg;
static int s_sock = -1;
static struct sockaddr_in s_target;
static uint32_t s_sequence;
static uint32_t s_sent;
static uint32_t s_send_errors;

static bool socket_open(void)
{
    if (s_sock >= 0) {
        return true;
    }
    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) {
        ESP_LOGE(TAG, "socket() failed: errno %d", errno);
        return false;
    }
    memset(&s_target, 0, sizeof(s_target));
    s_target.sin_family = AF_INET;
    s_target.sin_port = htons(s_cfg.target_port);
    if (inet_pton(AF_INET, s_cfg.target_ip, &s_target.sin_addr) != 1) {
        ESP_LOGE(TAG, "target_ip \"%s\" is not a valid IPv4 address", s_cfg.target_ip);
        close(s_sock);
        s_sock = -1;
        return false;
    }
    ESP_LOGI(TAG, "streaming to %s:%u", s_cfg.target_ip, (unsigned)s_cfg.target_port);
    return true;
}

/* Generate received data frames using ICMP echo replies. On the tested S3/AP
 * pair, UDP transmissions plus ACK dump produced only sparse CSI. Echo replies
 * provide actual incoming data packets without a separate host traffic service.
 */
static void poke_task(void *arg)
{
    (void)arg;
    esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
    config.count = ESP_PING_COUNT_INFINITE;
    config.interval_ms = 1000 / (s_cfg.poke_hz ? s_cfg.poke_hz : 100);
    if (config.interval_ms == 0) config.interval_ms = 1;
    config.timeout_ms = 100;
    config.data_size = 16;
    esp_ping_callbacks_t callbacks = {0};
    esp_ping_handle_t ping = NULL;
    if (!ipaddr_aton(s_cfg.target_ip, &config.target_addr)) {
        ESP_LOGE(TAG, "invalid traffic target IP");
        vTaskDelete(NULL);
        return;
    }
    esp_err_t err = esp_ping_new_session(&config, &callbacks, &ping);
    if (err == ESP_OK) {
        err = esp_ping_start(ping);
        if (err != ESP_OK) esp_ping_delete_session(ping);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ICMP traffic start failed: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "ICMP traffic to %s at up to %u Hz", s_cfg.target_ip,
                 (unsigned)s_cfg.poke_hz);
    }
    vTaskDelete(NULL);
}

static void report_task(void *arg)
{
    (void)arg;
    static uint8_t buffer[CSI_FRAME_MAX_LEN];
    TickType_t period = pdMS_TO_TICKS(1000 / (s_cfg.report_hz ? s_cfg.report_hz : 10));
    if (period == 0) {
        period = 1;
    }
    TickType_t last = xTaskGetTickCount();
    uint32_t last_captured = 0;

    for (;;) {
        vTaskDelayUntil(&last, period);
        if (!wifi_link_is_up() || !socket_open()) {
            continue;
        }

        csi_sample_t sample;
        if (!csi_capture_latest(&sample)) {
            continue;   /* link up, radio quiet — nothing to report, so report nothing */
        }
        /* Do not re-send a buffer already published. A repeated sample is a flat
         * line in the respiration waveform, which reads downstream as a subject
         * holding their breath rather than as a missing sample. */
        if (sample.captured_count == last_captured) {
            continue;
        }
        last_captured = sample.captured_count;

        csi_frame_t frame = {
            .node_id = s_cfg.node_id,
            .n_antennas = sample.n_antennas,
            .n_subcarriers = sample.n_subcarriers,
            .freq_mhz = csi_frame_channel_to_mhz(sample.channel),
            .sequence = s_sequence++,
            .rssi = sample.rssi,
            .noise_floor = sample.noise_floor,
            .ppdu_type = sample.ppdu_type,
            .flags = 0,
            .iq = sample.iq,
            .iq_len = sample.iq_len,
        };

        size_t len = csi_frame_pack(&frame, buffer, sizeof(buffer));
        if (len == 0) {
            s_send_errors++;
            continue;
        }
        int sent = sendto(s_sock, buffer, len, 0,
                          (struct sockaddr *)&s_target, sizeof(s_target));
        if (sent < 0) {
            s_send_errors++;
            /* A stale socket after a reconnect: drop it and reopen next tick. */
            close(s_sock);
            s_sock = -1;
        } else {
            s_sent++;
        }
    }
}

/*
 * Serial provisioning shell. Line-buffered on stdin so it works with plain
 * `idf.py monitor`, a terminal emulator, or tools/provision.py.
 */
static void console_task(void *arg)
{
    (void)arg;
    char line[160];
    size_t len = 0;

    printf("\nSENTINEL CSI node — type `show` for configuration, `help` for commands\n");
    for (;;) {
        int c = fgetc(stdin);
        if (c == EOF) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        if (c == '\r' || c == '\n') {
            if (len == 0) {
                continue;
            }
            line[len] = '\0';
            len = 0;
            if (strcmp(line, "help") == 0) {
                printf("commands: show | set <ssid|pass|ip|port|id|report_hz|poke_hz> <v>"
                       " | save | clear | reboot | stats\n");
            } else if (strcmp(line, "stats") == 0) {
                printf("link=%s ip=%s rssi=%d ch=%u disconnects=%u csi=%u dropped=%u"
                       " sent=%u errors=%u\n",
                       wifi_link_is_up() ? "up" : "down", wifi_link_ip(),
                       (int)wifi_link_rssi(), (unsigned)wifi_link_channel(),
                       (unsigned)wifi_link_disconnects(), (unsigned)csi_capture_count(),
                       (unsigned)csi_capture_dropped(), (unsigned)s_sent,
                       (unsigned)s_send_errors);
            } else if (!node_config_command(&s_cfg, line)) {
                printf("ERR unknown command — try `help`\n");
            }
            continue;
        }
        if (len + 1 < sizeof(line)) {
            line[len++] = (char)c;
        }
    }
}

static void status_task(void *arg)
{
    (void)arg;
    uint32_t last_csi = 0;
    uint32_t last_sent = 0;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(STATUS_PERIOD_MS));
        const uint32_t csi = csi_capture_count();
        const uint32_t sent = s_sent;
        const float secs = STATUS_PERIOD_MS / 1000.0f;

        ESP_LOGI(TAG,
                 "node %u | link %s %s | rssi %d dBm ch %u | csi %.1f Hz | tx %.1f Hz | errors %u",
                 (unsigned)s_cfg.node_id, wifi_link_is_up() ? "up" : "DOWN", wifi_link_ip(),
                 (int)wifi_link_rssi(), (unsigned)wifi_link_channel(),
                 (csi - last_csi) / secs, (sent - last_sent) / secs,
                 (unsigned)s_send_errors);

        /* The two failures worth calling out explicitly, because both look like
         * "no people detected" from the console rather than like a fault. */
        if (wifi_link_is_up() && csi == last_csi) {
            ESP_LOGW(TAG, "link is up but no CSI is arriving — check that power save is off "
                          "and that the poke traffic is reaching the AP");
        }
        if (csi > last_csi && sent == last_sent) {
            ESP_LOGW(TAG, "capturing CSI but sending nothing — check target_ip/port and "
                          "that UDP %u is open on the host", (unsigned)s_cfg.target_port);
        }
        last_csi = csi;
        last_sent = sent;
    }
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    node_config_load(&s_cfg);
    node_config_print(&s_cfg);

    /* An unprovisioned node stays in the console rather than joining nothing in
     * a loop: it is sitting on a bench waiting to be told who it is. */
    xTaskCreate(console_task, "console", 4096, NULL, 3, NULL);
    if (!s_cfg.configured) {
        ESP_LOGW(TAG, "unprovisioned — set ssid/pass/ip then `save` and `reboot`");
        return;
    }

    if (!wifi_link_start(s_cfg.ssid, s_cfg.password)) {
        ESP_LOGE(TAG, "wifi failed to start");
        return;
    }

    /* CSI configuration must follow esp_wifi_start(). */
    for (int i = 0; i < 100 && !wifi_link_is_up(); i++) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!csi_capture_start()) {
        ESP_LOGE(TAG, "CSI capture failed to start");
        return;
    }

    xTaskCreate(poke_task, "poke", 4096, NULL, 5, NULL);
    xTaskCreate(report_task, "report", 8192, NULL, 6, NULL);
    xTaskCreate(status_task, "status", 4096, NULL, 2, NULL);

    ESP_LOGI(TAG, "node %u streaming %u Hz to %s:%u (poke %u Hz)",
             (unsigned)s_cfg.node_id, (unsigned)s_cfg.report_hz, s_cfg.target_ip,
             (unsigned)s_cfg.target_port, (unsigned)s_cfg.poke_hz);
}

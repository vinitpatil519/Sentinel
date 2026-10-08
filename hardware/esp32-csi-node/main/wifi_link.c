#include "wifi_link.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "wifi";

static bool s_up;
static uint32_t s_disconnects;
static char s_ip[16] = "0.0.0.0";

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_up = false;
        s_disconnects++;
        strcpy(s_ip, "0.0.0.0");
        /* A short fixed backoff: the AP is usually rebooting, and an
         * exponential backoff would leave a node dark for minutes. */
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_wifi_connect();
        return;
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&event->ip_info.ip));
        s_up = true;
        ESP_LOGI(TAG, "link up, ip %s", s_ip);
    }
}

bool wifi_link_start(const char *ssid, const char *password)
{
    if (ssid == NULL || ssid[0] == '\0') {
        ESP_LOGE(TAG, "no SSID configured");
        return false;
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL, NULL));

    wifi_config_t wifi_config = {0};
    strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    if (password != NULL) {
        strncpy((char *)wifi_config.sta.password, password,
                sizeof(wifi_config.sta.password) - 1);
    }
    /* Accept an open AP too: a bench hotspot is often left open, and failing to
     * associate for that reason is a confusing way to lose an afternoon. */
    wifi_config.sta.threshold.authmode =
        (password != NULL && password[0] != '\0') ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* Must come after start(). Modem sleep parks the radio between beacons and
     * makes the CSI series unusably irregular. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    ESP_LOGI(TAG, "connecting to \"%s\"", ssid);
    return true;
}

bool wifi_link_is_up(void)
{
    return s_up;
}

int8_t wifi_link_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        return ap.rssi;
    }
    return 0;
}

uint8_t wifi_link_channel(void)
{
    uint8_t primary = 0;
    wifi_second_chan_t second;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK) {
        return primary;
    }
    return 0;
}

const char *wifi_link_ip(void)
{
    return s_ip;
}

uint32_t wifi_link_disconnects(void)
{
    return s_disconnects;
}

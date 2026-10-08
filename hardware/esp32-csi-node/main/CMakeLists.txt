idf_component_register(
    SRCS
        "app_main.c"
        "csi_capture.c"
        "csi_frame.c"
        "node_config.c"
        "wifi_link.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_netif esp_event nvs_flash lwip esp_timer
)

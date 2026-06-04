# tgcloud-wechat: WOC instance image + tg CLI for agent data extraction
# Multi-arch: linux/amd64, linux/arm64

# --- Stage 1: Build tg from source (Rust, multi-arch) ---
FROM rust:1-bookworm AS tg-builder
WORKDIR /build
COPY 3rd/tg/ .
RUN cargo build --release --bin tg && strip target/release/tg

# --- Stage 2: WOC instance image with tg baked in ---
FROM lscr.io/linuxserver/baseimage-kasmvnc:debianbookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates locales dpkg \
        fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk fonts-noto-color-emoji \
        libnss3 libgbm1 libasound2 libxss1 \
        xdotool xclip; \
    sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libatomic1 \
        libxdamage1 \
        libxkbcommon-x11-0 \
        libxcb-icccm4 \
        libxcb-image0 \
        libxcb-keysyms1 \
        libxcb-render-util0 \
        libxcb-xkb1 \
        libxcb-cursor0 \
        libgtk-3-0 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        libcups2 \
        libxcomposite1 \
        libxrandr2 \
        libxfixes3 \
        libxtst6 \
        libxshmfence1 \
        libdrm2; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LIBGL_ALWAYS_SOFTWARE=1

# IME patches from WOC
COPY 3rd/WechatOnCloud/docker/woc-www-patch.sh 3rd/WechatOnCloud/docker/woc-ime.pl /woc/
RUN chmod +x /woc/woc-www-patch.sh && /woc/woc-www-patch.sh

# WeChat download/install control script
COPY 3rd/WechatOnCloud/docker/wechat-ctl.sh /woc/wechat-ctl.sh
RUN chmod +x /woc/wechat-ctl.sh

# Autostart + update hook
COPY 3rd/WechatOnCloud/docker/autostart /defaults/autostart
RUN chmod +x /defaults/autostart
COPY 3rd/WechatOnCloud/docker/woc-update-autostart /custom-cont-init.d/01-woc-autostart
RUN chmod +x /custom-cont-init.d/01-woc-autostart

# --- tg binary ---
COPY --from=tg-builder /build/target/release/tg /usr/local/bin/tg
RUN chmod +x /usr/local/bin/tg

EXPOSE 3000 3001

# SPDX-License-Identifier: Apache-2.0
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-easy-discovery
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=CiBeDerORG
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-easy-discovery
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Easy Discovery - LAN devices and wireless ADB discovery
  DEPENDS:=+luci-base +rpcd-mod-file +rpcd-mod-luci +jshn +jsonfilter +uhttpd-mod-ubus +openssl-util +ucode +ucode-mod-fs +ucode-mod-ubus +ip
  CONFLICTS:=luci-app-avahi-web
  PKGARCH:=all
endef

define Package/luci-app-easy-discovery/description
 On-demand local network device and wireless ADB discovery for LuCI.
 Includes independent dependency/service management, capability-scoped RPCD
 authorization, volatile snapshots and compatibility with EasyADB clients.
 Avahi, D-Bus and arp-scan are optional and installed explicitly in the UI.
endef

define Package/luci-app-easy-discovery/conffiles
/etc/config/easy-discovery
endef

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/luci-app-easy-discovery/install
	$(INSTALL_DIR) $(1)/
	$(CP) ./root/* $(1)/
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	chmod 0755 $(1)/usr/libexec/luci-easy-discovery* $(1)/usr/libexec/luci-avahi-scan
	chmod 0755 $(1)/usr/libexec/rpcd/easy-discovery.*
	chmod 0600 $(1)/etc/config/easy-discovery
endef

define Package/luci-app-easy-discovery/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

define Package/luci-app-easy-discovery/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-easy-discovery))

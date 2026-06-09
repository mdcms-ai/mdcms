"use client";

import { createContext, use, type PropsWithChildren } from "react";

export type AdminCapabilitiesValue = {
  canReadSchema: boolean;
  canCreateContent: boolean;
  canPublishContent: boolean;
  canUnpublishContent: boolean;
  canDeleteContent: boolean;
  canManageUsers: boolean;
  canManageSettings: boolean;
  canReadMedia: boolean;
  canUploadMedia: boolean;
  canDeleteMedia: boolean;
};

const DEFAULT_ADMIN_CAPABILITIES: AdminCapabilitiesValue = {
  canReadSchema: false,
  canCreateContent: false,
  canPublishContent: false,
  canUnpublishContent: false,
  canDeleteContent: false,
  canManageUsers: false,
  canManageSettings: false,
  canReadMedia: false,
  canUploadMedia: false,
  canDeleteMedia: false,
};

const AdminCapabilitiesContext = createContext<AdminCapabilitiesValue>(
  DEFAULT_ADMIN_CAPABILITIES,
);

function normalizeAdminCapabilitiesValue(
  value: Partial<AdminCapabilitiesValue>,
): AdminCapabilitiesValue {
  return {
    canReadSchema: value.canReadSchema ?? false,
    canCreateContent: value.canCreateContent ?? false,
    canPublishContent: value.canPublishContent ?? false,
    canUnpublishContent: value.canUnpublishContent ?? false,
    canDeleteContent: value.canDeleteContent ?? false,
    canManageUsers: value.canManageUsers ?? false,
    canManageSettings: value.canManageSettings ?? false,
    canReadMedia: value.canReadMedia ?? false,
    canUploadMedia: value.canUploadMedia ?? false,
    canDeleteMedia: value.canDeleteMedia ?? false,
  };
}

export function AdminCapabilitiesProvider({
  value,
  children,
}: PropsWithChildren<{
  value: Partial<AdminCapabilitiesValue>;
}>) {
  return (
    <AdminCapabilitiesContext.Provider
      value={normalizeAdminCapabilitiesValue(value)}
    >
      {children}
    </AdminCapabilitiesContext.Provider>
  );
}

export function useAdminCapabilities(): AdminCapabilitiesValue {
  return use(AdminCapabilitiesContext);
}

export function useCanReadSchema(): boolean {
  return useAdminCapabilities().canReadSchema;
}

export function useCanManageUsers(): boolean {
  return useAdminCapabilities().canManageUsers;
}

export function useCanManageSettings(): boolean {
  return useAdminCapabilities().canManageSettings;
}

export function useCanReadMedia(): boolean {
  return useAdminCapabilities().canReadMedia;
}

export function useCanUploadMedia(): boolean {
  return useAdminCapabilities().canUploadMedia;
}

export function useCanDeleteMedia(): boolean {
  return useAdminCapabilities().canDeleteMedia;
}

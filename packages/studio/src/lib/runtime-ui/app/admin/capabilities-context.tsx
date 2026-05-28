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
};

const DEFAULT_ADMIN_CAPABILITIES: AdminCapabilitiesValue = {
  canReadSchema: false,
  canCreateContent: false,
  canPublishContent: false,
  canUnpublishContent: false,
  canDeleteContent: false,
  canManageUsers: false,
  canManageSettings: false,
};

const AdminCapabilitiesContext = createContext<AdminCapabilitiesValue>(
  DEFAULT_ADMIN_CAPABILITIES,
);

export function AdminCapabilitiesProvider({
  value,
  children,
}: PropsWithChildren<{
  value: AdminCapabilitiesValue;
}>) {
  return (
    <AdminCapabilitiesContext.Provider value={value}>
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

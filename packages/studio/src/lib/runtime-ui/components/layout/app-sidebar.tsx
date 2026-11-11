"use client";

import Link from "../../adapters/next-link.js";
import {
  resolveStudioHref,
  useBasePath,
  usePathname,
} from "../../adapters/next-navigation.js";
import { useCanReadSchema } from "../../app/admin/capabilities-context.js";
import {
  LayoutDashboard,
  FileText,
  GitBranch,
  Image,
  Users,
  Settings,
  Trash2,
  FolderInput,
  Terminal,
  Workflow,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip.js";
import { useStudioSession } from "../../app/admin/session-context.js";
import { useStudioMountInfo } from "../../app/admin/mount-info-context.js";
import { MDCMSLogo } from "../mdcms-logo.js";

interface AppSidebarProps {
  canReadSchema?: boolean;
  canManageUsers?: boolean;
  canManageSettings?: boolean;
  collapsed: boolean;
  onToggle: () => void;
}

type NavItem = {
  icon: typeof LayoutDashboard;
  label: string;
  href: string;
  hint?: string;
};

const mainNavItems: ReadonlyArray<NavItem> = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/admin" },
  { icon: FileText, label: "Content", href: "/admin/content" },
  {
    icon: FolderInput,
    label: "Schema",
    href: "/admin/schema",
    hint: "read-only",
  },
  { icon: GitBranch, label: "Environments", href: "/admin/environments" },
  { icon: Image, label: "Media", href: "/admin/media" },
  { icon: Workflow, label: "Workflows", href: "/admin/workflows" },
  { icon: Terminal, label: "API", href: "/admin/api" },
  { icon: Trash2, label: "Trash", href: "/admin/trash" },
];

const adminNavItems: ReadonlyArray<NavItem> = [
  { icon: Users, label: "Users", href: "/admin/users" },
  { icon: Settings, label: "Settings", href: "/admin/settings" },
];

function filterNav(
  items: ReadonlyArray<NavItem>,
  filters: {
    canReadSchema: boolean;
    canManageUsers: boolean;
    canManageSettings: boolean;
  },
): NavItem[] {
  const canManageAdminSurfaces =
    filters.canManageUsers || filters.canManageSettings;

  return items.filter((item) => {
    if (item.href === "/admin/environments") return canManageAdminSurfaces;
    if (item.href === "/admin/schema") return filters.canReadSchema;
    if (item.href === "/admin/users") return filters.canManageUsers;
    if (item.href === "/admin/settings") return filters.canManageSettings;
    return true;
  });
}

function deriveInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return (local.slice(0, 2) || "??").toUpperCase();
}

function deriveDisplayName(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "Studio";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function AppSidebar({
  canReadSchema,
  canManageUsers,
  canManageSettings,
  collapsed,
  onToggle,
}: AppSidebarProps) {
  const pathname = usePathname();
  const basePath = useBasePath();
  const contextCanReadSchema = useCanReadSchema();
  const sessionState = useStudioSession();
  const mountInfo = useStudioMountInfo();

  const effectiveCanReadSchema = canReadSchema ?? contextCanReadSchema;
  const effectiveCanManageUsers = canManageUsers ?? false;
  const effectiveCanManageSettings = canManageSettings ?? false;

  const filters = {
    canReadSchema: effectiveCanReadSchema,
    canManageUsers: effectiveCanManageUsers,
    canManageSettings: effectiveCanManageSettings,
  };

  const visibleMain = filterNav(mainNavItems, filters);
  const visibleAdmin = filterNav(adminNavItems, filters);
  const showAdminSection = visibleAdmin.length > 0;

  const session =
    sessionState.status === "authenticated" ? sessionState.session : null;
  const accountInitials = session ? deriveInitials(session.email) : "MD";
  const accountName = session ? deriveDisplayName(session.email) : "Studio";
  const accountMeta = mountInfo.project ?? "MDCMS";

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300",
          collapsed ? "w-16" : "w-60",
        )}
      >
        {/* Brand */}
        <div
          className={cn(
            "flex h-14 items-center gap-2.5 border-b border-sidebar-border px-3.5",
            collapsed && "justify-center px-2",
          )}
        >
          <Link
            href={resolveStudioHref(basePath, "/admin")}
            className="flex items-center gap-2.5 text-sidebar-foreground"
          >
            <MDCMSLogo
              collapsed={collapsed}
              className="text-sidebar-foreground"
            />
          </Link>
        </div>

        {/* Main Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
          <ul className="space-y-0.5">
            {visibleMain.map((item) => (
              <li key={item.href}>
                <SidebarNavLink
                  item={item}
                  pathname={pathname}
                  basePath={basePath}
                  collapsed={collapsed}
                />
              </li>
            ))}
          </ul>

          {showAdminSection && (
            <>
              {!collapsed && (
                <div className="mt-5 px-3 pb-1.5 text-xs font-medium text-sidebar-foreground-faint">
                  Admin
                </div>
              )}
              {collapsed && (
                <div className="my-3 border-t border-sidebar-border" />
              )}
              <ul className="space-y-0.5">
                {visibleAdmin.map((item) => (
                  <li key={item.href}>
                    <SidebarNavLink
                      item={item}
                      pathname={pathname}
                      basePath={basePath}
                      collapsed={collapsed}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>

        {/* Account / collapse */}
        <div className="border-t border-sidebar-border p-2 space-y-1">
          {!collapsed && session && (
            <div className="flex items-center gap-2.5 p-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent font-heading text-[11px] font-semibold text-vibrant-green-foreground">
                {accountInitials}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px] font-medium text-sidebar-foreground">
                  {accountName}
                </div>
                <div className="truncate font-mono text-[11px] text-sidebar-foreground-muted">
                  {accountMeta}
                </div>
              </div>
            </div>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggle}
                className={cn(
                  "w-full justify-center border-0 bg-transparent text-sidebar-foreground-muted hover:bg-sidebar-surface hover:text-sidebar-foreground",
                  !collapsed && "justify-start gap-3 px-3",
                )}
              >
                {collapsed ? (
                  <ChevronsRight className="size-5" />
                ) : (
                  <>
                    <ChevronsLeft className="size-5" />
                    <span>Collapse</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            )}
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}

function SidebarNavLink({
  item,
  pathname,
  basePath,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  basePath: string | undefined;
  collapsed: boolean;
}) {
  const resolvedHref = resolveStudioHref(basePath, item.href);
  const isActive =
    pathname === resolvedHref ||
    (resolvedHref !== basePath && pathname.startsWith(`${resolvedHref}/`));

  const className = cn(
    "group flex h-9 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-colors",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-sidebar-foreground-muted hover:bg-sidebar-surface hover:text-sidebar-foreground",
    collapsed && "justify-center px-0 gap-0",
  );
  const link = (
    <Link
      href={resolvedHref}
      className={className}
      data-active={isActive ? "true" : undefined}
    >
      <item.icon className="size-[18px] shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.hint && (
            <span className="text-[11px] text-sidebar-foreground-faint">
              {item.hint}
            </span>
          )}
        </>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }
  return link;
}

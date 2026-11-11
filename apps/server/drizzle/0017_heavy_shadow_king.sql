ALTER TABLE "rbac_grants" DROP CONSTRAINT "rbac_grants_admin_owner_global_check";--> statement-breakpoint
ALTER TABLE "rbac_grants" ADD CONSTRAINT "rbac_grants_owner_admin_scope_check" CHECK ((
        ("rbac_grants"."role" <> 'owner' or "rbac_grants"."scope_kind" = 'global')
        and
        ("rbac_grants"."role" <> 'admin' or "rbac_grants"."scope_kind" in ('global', 'project'))
      ));
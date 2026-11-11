import { Workflow } from "lucide-react";
import { ComingSoon } from "../../components/coming-soon.js";
import { PageHeader } from "../../components/layout/page-header.js";

export default function WorkflowsPage() {
  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Workflows" }]} />
      <div className="p-6">
        <ComingSoon
          icon={Workflow}
          title="Workflows"
          description="Define review and approval steps for your content before it gets published."
        />
      </div>
    </div>
  );
}

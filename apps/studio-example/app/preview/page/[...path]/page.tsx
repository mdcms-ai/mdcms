import {
  createPreviewRequestUrl,
  fetchPreviewDocumentFromRequestUrl,
  type PreviewRouteSearchParams,
} from "../../../../lib/preview-content";
import { PreviewDocumentView } from "../../preview-document-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Page Preview | MDCMS Demo",
  description: "Preview a draft MDCMS page rendered through the SDK.",
};

type PagePreviewPageProps = {
  params: Promise<{
    path: string[];
  }>;
  searchParams?: Promise<PreviewRouteSearchParams>;
};

export default async function PagePreviewPage({
  params,
  searchParams,
}: PagePreviewPageProps) {
  const { path } = await params;
  const result = await fetchPreviewDocumentFromRequestUrl(
    createPreviewRequestUrl(
      `/preview/page/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
      await searchParams,
    ),
  );

  return PreviewDocumentView({ heading: "Page Preview", result });
}

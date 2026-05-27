import {
  createContext,
  use,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type PropsWithChildren,
} from "react";

import { isExternalHref, resolveStudioHref } from "./navigation-paths.js";

type StudioNavigationValue = {
  pathname: string;
  params: Record<string, string>;
  basePath?: string;
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
};

const StudioNavigationContext = createContext<
  StudioNavigationValue | undefined
>(undefined);

function useStudioNavigationContext(): StudioNavigationValue {
  const value = use(StudioNavigationContext);

  if (!value) {
    throw new Error(
      "Studio navigation hooks must be used within StudioNavigationProvider.",
    );
  }

  return value;
}

function isModifiedEvent(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.button !== 0
  );
}

export function StudioNavigationProvider({
  value,
  children,
}: PropsWithChildren<{
  value: StudioNavigationValue;
}>) {
  return (
    <StudioNavigationContext.Provider value={value}>
      {children}
    </StudioNavigationContext.Provider>
  );
}

export function usePathname(): string {
  return useStudioNavigationContext().pathname;
}

export function useBasePath(): string {
  return useStudioNavigationContext().basePath ?? "";
}

export function useParams<
  T extends Record<string, string> = Record<string, string>,
>(): T {
  return useStudioNavigationContext().params as T;
}

export function useRouter() {
  const navigation = useStudioNavigationContext();

  return {
    push: (href: string) =>
      navigation.push(resolveStudioHref(navigation.basePath, href)),
    replace: (href: string) =>
      navigation.replace(resolveStudioHref(navigation.basePath, href)),
    back: navigation.back,
  };
}

export function RuntimeLink({
  children,
  href,
  onClick,
  target,
  rel,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
}) {
  const navigation = useStudioNavigationContext();
  const resolvedHref = isExternalHref(href)
    ? href
    : resolveStudioHref(navigation.basePath, href);

  return (
    // react-doctor-disable-next-line react-doctor/no-prevent-default -- RuntimeLink preserves anchor semantics but intercepts same-origin clicks for the embedded Studio router.
    <a
      {...props}
      href={resolvedHref}
      target={target}
      rel={rel}
      onClick={(event) => {
        onClick?.(event);

        if (
          event.defaultPrevented ||
          target === "_blank" ||
          isModifiedEvent(event) ||
          isExternalHref(resolvedHref)
        ) {
          return;
        }

        event.preventDefault();
        navigation.push(resolvedHref);
      }}
    >
      {children}
    </a>
  );
}

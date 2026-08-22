import "@phosphor-icons/webcomponents/PhArrowRight";
import "@phosphor-icons/webcomponents/PhCheck";
import "@phosphor-icons/webcomponents/PhChecks";
import "@phosphor-icons/webcomponents/PhCloudCheck";
import "@phosphor-icons/webcomponents/PhDownloadSimple";
import "@phosphor-icons/webcomponents/PhEye";
import "@phosphor-icons/webcomponents/PhFileCode";
import "@phosphor-icons/webcomponents/PhGitBranch";
import "@phosphor-icons/webcomponents/PhKey";
import "@phosphor-icons/webcomponents/PhLockKey";
import "@phosphor-icons/webcomponents/PhMagnifyingGlass";
import "@phosphor-icons/webcomponents/PhShieldCheck";
import "@phosphor-icons/webcomponents/PhSlidersHorizontal";

const LANDING_ASSETS = {
  mark: new URL("../../mentorcode_logo.png", import.meta.url).href
} as const;

type LandingAssetName = keyof typeof LANDING_ASSETS;

class ElementQuery {
  public constructor(private readonly documentRef: Document) {}

  public optional<T extends Element>(selector: string): T | undefined {
    const element = this.documentRef.querySelector<T>(selector);
    return element ?? undefined;
  }

  public all<T extends Element>(selector: string): T[] {
    return Array.from(this.documentRef.querySelectorAll<T>(selector));
  }
}

class LogoAssetController {
  public constructor(private readonly images: readonly HTMLImageElement[]) {}

  public start(): void {
    for (const image of this.images) {
      const assetName = this.assetNameFor(image);
      if (!assetName) {
        continue;
      }

      image.src = LANDING_ASSETS[assetName];
      image.decoding = "async";
    }
  }

  private assetNameFor(image: HTMLImageElement): LandingAssetName | undefined {
    const value = image.dataset.logo;
    return value === "mark" ? value : undefined;
  }
}

class HeaderElevationController {
  private readonly update = (): void => {
    this.header.dataset.elevated = this.windowRef.scrollY > 8 ? "true" : "false";
  };

  public constructor(
    private readonly header: HTMLElement,
    private readonly windowRef: Window
  ) {}

  public start(): void {
    this.update();
    this.windowRef.addEventListener("scroll", this.update, { passive: true });
  }
}

class AnchorFocusController {
  public constructor(
    private readonly links: readonly HTMLAnchorElement[],
    private readonly documentRef: Document
  ) {}

  public start(): void {
    for (const link of this.links) {
      link.addEventListener("click", () => this.focusTarget(link));
    }
  }

  private focusTarget(link: HTMLAnchorElement): void {
    const hash = link.hash;
    if (!hash.startsWith("#") || hash.length <= 1) {
      return;
    }

    window.setTimeout(() => {
      const target = this.documentRef.getElementById(decodeURIComponent(hash.slice(1)));
      if (!target) {
        return;
      }

      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }, 120);
  }
}

class FaqDisclosureController {
  public constructor(private readonly detailsItems: readonly HTMLDetailsElement[]) {}

  public start(): void {
    for (const item of this.detailsItems) {
      item.addEventListener("toggle", () => this.closeSiblings(item));
    }
  }

  private closeSiblings(activeItem: HTMLDetailsElement): void {
    if (!activeItem.open) {
      return;
    }

    for (const item of this.detailsItems) {
      if (item !== activeItem) {
        item.open = false;
      }
    }
  }
}

class LandingApplication {
  private readonly query: ElementQuery;

  public constructor(private readonly documentRef: Document) {
    this.query = new ElementQuery(documentRef);
  }

  public start(): void {
    this.startLogoAssets();
    this.startHeaderElevation();
    this.startAnchorFocus();
    this.startFaqDisclosure();
  }

  private startLogoAssets(): void {
    const images = this.query.all<HTMLImageElement>("img[data-logo]");
    new LogoAssetController(images).start();
  }

  private startHeaderElevation(): void {
    const header = this.query.optional<HTMLElement>("[data-header]");
    if (!header) {
      return;
    }

    new HeaderElevationController(header, window).start();
  }

  private startAnchorFocus(): void {
    const links = this.query.all<HTMLAnchorElement>('a[href^="#"]');
    new AnchorFocusController(links, this.documentRef).start();
  }

  private startFaqDisclosure(): void {
    const detailsItems = this.query.all<HTMLDetailsElement>(".faq-list details");
    new FaqDisclosureController(detailsItems).start();
  }
}

new LandingApplication(document).start();

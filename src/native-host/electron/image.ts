// nativeImage over the native host: an image crosses to Swift as a descriptor (a file path, an SF
// Symbol name, or empty), never as pixels.
import { ui } from "./bridge";

/** Electron's rule: a file named `...Template.png` (or `@2x`) is a template image. */
const isTemplatePath = (path: string): boolean => /Template(@\dx)?\.\w+$/.test(path);

export type ImageDescriptor = { kind: "path"; path: string; template: boolean } | { kind: "symbol"; name: string } | { kind: "empty" };

export class NativeImage {
  private empty: boolean | null = null;
  constructor(private descriptor: ImageDescriptor) {}
  /** @internal */ describe(): ImageDescriptor { return this.descriptor; }
  isEmpty(): boolean {
    if (this.descriptor.kind === "empty") return true;
    if (this.descriptor.kind === "symbol") return false;
    return (this.empty ??= ui<boolean>("imageIsEmpty", this.descriptor.path));
  }
  setTemplateImage(template: boolean): void {
    if (this.descriptor.kind === "path") this.descriptor = { ...this.descriptor, template };
  }
  isTemplateImage(): boolean { return this.descriptor.kind === "path" && this.descriptor.template; }
  getSize(): { width: number; height: number } { return this.isEmpty() ? { width: 0, height: 0 } : ui("imageSize", this.descriptor); }
  getAspectRatio(): number { const { width, height } = this.getSize(); return height ? width / height : 1; }
  resize(_options: unknown): NativeImage { return this; }
  toDataURL(): string { return ""; }
}

export function imageDescriptor(image: NativeImage | string | null | undefined): ImageDescriptor {
  if (!image) return { kind: "empty" };
  if (typeof image === "string") return { kind: "path", path: image, template: isTemplatePath(image) };
  return image.describe();
}

export const nativeImage = {
  createFromPath: (path: string) => new NativeImage({ kind: "path", path, template: isTemplatePath(path) }),
  createEmpty: () => new NativeImage({ kind: "empty" }),
  createMenuSymbol: (name: string) => new NativeImage({ kind: "symbol", name }),
  createFromNamedImage: (name: string) => new NativeImage({ kind: "symbol", name })
};

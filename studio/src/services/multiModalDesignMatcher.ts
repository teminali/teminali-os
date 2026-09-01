/**
 * Contract for future measured design extraction. No production method in this
 * module claims pixel or video analysis until a real media runner is connected.
 */

export interface DesignReferenceInput {
  type: "screenshot" | "isometric_mockup" | "video_recording" | "figma_node";
  sourceUri: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface ExtractedDesignDNA {
  colorPalette: {
    primaryBg: string;
    containerBg: string;
    accentBrand: string;
    textPrimary: string;
    textMuted: string;
    borders: string;
    gradients: string[];
  };
  typography: {
    fontFamilies: string[];
    scale: { size: string; weight: number; lineHeight: string }[];
  };
  layoutMatrix: {
    system: "css_grid" | "flexbox_stacked" | "bento_grid";
    columnTemplate: string;
    rowTemplate?: string;
    gap: string;
    padding: string;
  };
  temporalStates: {
    stateName: "default" | "hover" | "active" | "expanded_modal";
    triggerSelector: string;
    cssTransform: string;
    animationTiming: string;
  }[];
  antiHallucinationConfidence: number; // 0 - 100%
}

export class MultiModalDesignMatcher {
  /**
   * Image dimensions alone cannot identify a bezel or recover perspective.
   */
  public static isolateCanvasFromMockup(imageWidth: number, imageHeight: number): {
    cropX: number;
    cropY: number;
    cropWidth: number;
    cropHeight: number;
    perspectiveAngleDeg: number;
  } {
    throw new Error(
      `Canvas isolation is unmeasured: no pixel analyzer is configured for the ${imageWidth}×${imageHeight} input.`,
    );
  }

  /**
   * Deconstruct a video recording into temporal interaction keyframes
   */
  public static extractTemporalStates(videoDurationSec: number): ExtractedDesignDNA["temporalStates"] {
    throw new Error(
      `Temporal-state extraction is unmeasured: no video runner is configured for the ${videoDurationSec}-second input.`,
    );
  }

  /**
   * Generate complete, zero-hallucination design DNA from any reference
   */
  public static reverseEngineerReference(input: DesignReferenceInput): ExtractedDesignDNA {
    throw new Error(
      `Design extraction is unmeasured: ${input.type} at ${input.sourceUri} was not processed by a pixel-capable runner.`,
    );
  }
}

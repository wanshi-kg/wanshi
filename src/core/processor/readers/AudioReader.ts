import { FileReader, FileReadResult } from "./FileReader";
import { logger } from "../../../shared/logger";
import path from "path";
import fs from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import { nodewhisper } from "nodejs-whisper";
import { promisify } from "util";
import { stat } from "fs/promises";

/**
 * Reader for audio/video files with speech transcription
 *
 * This implementation uses:
 * - fluent-ffmpeg for audio/video preprocessing and metadata extraction
 * - nodejs-whisper for speech-to-text transcription with timestamps
 *
 * Required dependencies:
 * npm install fluent-ffmpeg nodejs-whisper ffmpeg-static ffprobe-static
 *
 * System requirements:
 * - FFmpeg binary (automatically handled by ffmpeg-static)
 * - Whisper models (automatically downloaded by nodejs-whisper)
 *
 * Supported formats: .mp3, .mp4, .wav, .ogg, .m4a, .flac, .aac, .webm, .mkv, .avi
 */
export class AudioReader extends FileReader {
  private tempDir: string;
  private options: AudioProcessingOptions;

  constructor(
    options: AudioProcessingOptions = {
      modelName: "medium",
      language: "auto",
    },
    tempDir = "./temp"
  ) {
    super([
      ".mp3",
      ".mp4",
      ".wav",
      ".ogg",
      ".m4a",
      ".flac",
      ".aac",
      ".webm",
      ".mkv",
      ".avi",
    ]);
    this.tempDir = tempDir;
    this.options = options;
    this.ensureTempDir();
  }

  getName(): string {
    return "AudioReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      logger.debug(`Reading audio/video file: ${filePath}`);

      const stats = await stat(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Step 1: Extract audio metadata using ffprobe
      const audioMetadata = await this.extractAudioMetadata(filePath);

      // Step 2: Convert to WAV for Whisper if needed
      const processedAudioPath = await this.preprocessAudio(filePath);

      // Step 3: Transcribe using Whisper
      const transcriptionResult = await this.transcribeAudio(
        processedAudioPath,
        audioMetadata
      );

      // Step 4: Clean up temporary files
      await this.cleanup(processedAudioPath, filePath);

      // Build comprehensive metadata
      const metadata = {
        type: this.getMediaType(ext),
        description: this.getMediaDescription(ext),
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        extension: ext,

        // Audio-specific metadata
        ...audioMetadata,

        // Transcription metadata
        ...transcriptionResult.metadata,

        status: "success",
        processingTime: transcriptionResult.processingTime,
        transcriptionLength: transcriptionResult.content.length,
        hasTranscription: transcriptionResult.content.trim().length > 0,
      };

      logger.debug(
        `Successfully transcribed ${filePath}: ${transcriptionResult.content.length} characters`
      );

      return {
        content: transcriptionResult.content,
        metadata: metadata,
      };
    } catch (error: any) {
      logger.error(`Failed to read audio file ${filePath}: ${error.message}`);

      return {
        content: "",
        metadata: {
          type: this.getMediaType(path.extname(filePath).toLowerCase()),
          description: this.getMediaDescription(path.extname(filePath)),
          fileName: path.basename(filePath),
          filePath: filePath,
          status: "error",
          error: error.message,
          errorType: error.name,
          processingStep: error.step || "unknown",
        },
      };
    }
  }

  /**
   * Extract audio metadata using ffprobe
   */
  private async extractAudioMetadata(filePath: string): Promise<any> {
    try {
      const ffprobe = promisify(ffmpeg.ffprobe);
      const metadata = (await ffprobe(filePath)) as any;

      const audioStream = metadata.streams.find(
        // @ts-expect-error
        (stream) => stream.codec_type === "audio"
      );
      const videoStream = metadata.streams.find(
        // @ts-expect-error
        (stream) => stream.codec_type === "video"
      );

      return {
        // General file metadata
        duration: parseFloat(metadata.format.duration || "0"),
        bitrate: parseInt(metadata.format.bit_rate || "0"),
        formatName: metadata.format.format_name,
        formatLongName: metadata.format.format_long_name,

        // Audio stream metadata
        audioCodec: audioStream?.codec_name || "unknown",
        audioSampleRate: parseInt(audioStream?.sample_rate || "0"),
        audioChannels: audioStream?.channels || 0,
        audioChannelLayout: audioStream?.channel_layout || "unknown",
        audioBitrate: parseInt(audioStream?.bit_rate || "0"),

        // Video metadata (if present)
        hasVideo: !!videoStream,
        videoCodec: videoStream?.codec_name || null,
        videoResolution: videoStream
          ? `${videoStream.width}x${videoStream.height}`
          : null,
        videoFrameRate: videoStream?.r_frame_rate || null,

        // Metadata tags
        title: metadata.format.tags?.title || "",
        artist: metadata.format.tags?.artist || "",
        album: metadata.format.tags?.album || "",
        genre: metadata.format.tags?.genre || "",
        date: metadata.format.tags?.date || "",
        comment: metadata.format.tags?.comment || "",
      };
    } catch (error: any) {
      logger.warn(`Could not extract audio metadata: ${error.message}`);
      return {
        duration: 0,
        bitrate: 0,
        formatName: "unknown",
        audioCodec: "unknown",
        audioSampleRate: 0,
        audioChannels: 0,
      };
    }
  }

  /**
   * Convert audio to optimal format for Whisper
   */
  private async preprocessAudio(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    // If it's already a WAV file, check if it needs resampling
    if (ext === ".wav") {
      const metadata = await this.extractAudioMetadata(filePath);
      if (metadata.audioSampleRate === 16000 && metadata.audioChannels <= 2) {
        logger.debug(
          "WAV file already in optimal format, skipping preprocessing"
        );
        return filePath;
      }
    }

    const outputPath = path.join(
      this.tempDir,
      `${path.basename(filePath, ext)}_processed_${Date.now()}.wav`
    );

    return new Promise((resolve, reject) => {
      logger.debug(`Converting ${filePath} to WAV format for Whisper`);

      ffmpeg(filePath)
        .audioFrequency(16000) // Whisper loves 16kHz
        .audioChannels(1) // Convert to mono for better performance
        .audioCodec("pcm_s16le") // Uncompressed PCM
        .format("wav")
        .on("start", (commandLine) => {
          logger.debug(`FFmpeg process started: ${commandLine}`);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            logger.debug(
              `Audio conversion progress: ${Math.round(progress.percent)}%`
            );
          }
        })
        .on("error", (error) => {
          // @ts-expect-error
          error.step = "audio_preprocessing";
          reject(error);
        })
        .on("end", () => {
          logger.debug(`Audio conversion completed: ${outputPath}`);
          resolve(outputPath);
        })
        .save(outputPath);
    });
  }

  /**
   * Transcribe audio using Whisper
   */
  private async transcribeAudio(
    audioPath: string,
    audioMetadata: any
  ): Promise<{ content: string; metadata: any; processingTime: number }> {
    const startTime = Date.now();

    try {
      logger.debug(
        `Transcribing with Whisper model: ${this.options.modelName}`
      );

      const options = {
        modelName: this.options.modelName,
        removeWavFileAfterTranscription: false, // We'll handle cleanup ourselves
        autoDownloadModelName: this.options.modelName,
        whisperOptions: {
          language: this.options.language, // Auto-detect language
          outputInText: true,
          outputInJson: true, // Get detailed results
          outputInSrt: true, // Get timestamps
          wordTimestamps: true, // Word-level timestamps
          translateToEnglish: false, // Keep original language
          splitOnWord: true,
        },
      };

      // Run Whisper transcription
      const content = await nodewhisper(audioPath, options);

      const processingTime = Date.now() - startTime;

      // Build transcription metadata
      const transcriptionMetadata = {
        whisperModel: this.options.modelName,
        detectedLanguage: (content as any).language || "unknown",
        transcriptionConfidence: (content as any).confidence || null,
        wordCount: content.split(/\s+/).filter((word) => word.length > 0)
          .length,
        hasTimestamps: options.whisperOptions.wordTimestamps,
        processingTimeMs: processingTime,
      };

      return {
        content: content.trim(),
        metadata: transcriptionMetadata,
        processingTime: processingTime,
      };
    } catch (error: any) {
      error.step = "transcription";
      throw error;
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanup(
    processedPath: string,
    originalPath: string
  ): Promise<void> {
    try {
      // Only delete if it's a temporary file we created
      if (
        processedPath !== originalPath &&
        processedPath.includes(this.tempDir)
      ) {
        await fs.unlink(processedPath);
        logger.debug(`Cleaned up temporary file: ${processedPath}`);
      }
    } catch (error) {
      logger.warn(
        `Could not clean up temporary file ${processedPath}: ${error}`
      );
    }
  }

  /**
   * Ensure temp directory exists
   */
  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.warn(`Could not create temp directory ${this.tempDir}: ${error}`);
    }
  }

  /**
   * Get media type based on extension
   */
  private getMediaType(ext: string): string {
    const audioExts = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];
    const videoExts = [".mp4", ".webm", ".mkv", ".avi"];

    if (audioExts.includes(ext)) return "audio";
    if (videoExts.includes(ext)) return "video";
    return "media";
  }

  /**
   * Get human-readable description
   */
  private getMediaDescription(ext: string): string {
    const descriptions: { [key: string]: string } = {
      ".mp3": "MP3 Audio File",
      ".mp4": "MP4 Video File",
      ".wav": "WAV Audio File",
      ".ogg": "OGG Audio File",
      ".m4a": "M4A Audio File",
      ".flac": "FLAC Audio File",
      ".aac": "AAC Audio File",
      ".webm": "WebM Video File",
      ".mkv": "Matroska Video File",
      ".avi": "AVI Video File",
    };
    return descriptions[ext] || "Media File";
  }
}

/**
 * Configuration interface for Whisper transcription
 */
export interface WhisperConfig {
  modelName?: string;
  language?: string;
  translateToEnglish?: boolean;
  wordTimestamps?: boolean;
  outputFormats?: {
    text?: boolean;
    json?: boolean;
    srt?: boolean;
    vtt?: boolean;
  };
}

/**
 * Audio processing options interface
 */
export interface AudioProcessingOptions {
  modelName: string;
  language: string;
}

/**
 * Audio metadata interface
 */
export interface AudioMetadata {
  duration: number;
  bitrate: number;
  formatName: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
  hasVideo: boolean;
  title?: string;
  artist?: string;
  album?: string;
}

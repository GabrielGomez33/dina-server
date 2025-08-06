// /src/modules/mirror/types/index.ts
/**
 * MIRROR MODULE TYPES - COMPLETE INTERFACE DEFINITIONS (FIXED)
 * 
 * FIXES APPLIED:
 * ✅ Removed duplicate export declarations (lines 1188-1201)
 * ✅ Single source of truth for all type exports
 * ✅ Proper interface definitions with no conflicts
 */

// ============================================================================
// CORE MIRROR DATA STRUCTURES
// ============================================================================

export interface MirrorUserSubmission {
  userRegistered: boolean;
  name: string;
  photo: Buffer | Uint8Array | ArrayBuffer;
  
  // Comprehensive facial analysis with 68-point landmarks
  faceAnalysis: {
    detection: FaceDetectionData;
    landmarks: FacialLandmarkData;      // 68 precise coordinate points
    unshiftedLandmarks: FacialLandmarkData;
    alignedRect: AlignedFaceData;
    angle: HeadPoseData;               // Roll, pitch, yaw angles
    expressions: EmotionScores;        // 7 emotions with confidence scores
  };
  
  // Voice analysis with device metadata
  voice: AudioData;
  voiceMetadata: {
    mimeType: string;
    duration: number;
    size: number;
    deviceInfo: DeviceInfo;
    analysis: SpeechAnalysis;          // WPM, volume, silence analysis
  };
  voicePrompt: string;
  
  // Comprehensive IQ assessment
  iqResults: {
    rawScore: number;
    totalQuestions: number;
    iqScore: number;
    category: string;
    strengths: string[];
    description: string;
  };
  iqAnswers: Record<string, string>;   // Detailed answer tracking
  
  // Multi-cultural astrological analysis
  astrologicalResult: {
    western: WesternAstrologyData;     // Sun, moon, rising, houses, planets
    chinese: ChineseAstrologyData;     // Animal, element, compatibility
    african: AfricanAstrologyData;     // Orisha, ancestral spirits
    numerology: NumerologyData;        // Life path, destiny numbers
    synthesis: AstrologicalSynthesis;  // Integrated insights
  };
  
  // Dual personality framework
  personalityResult: {
    big5Profile: Big5Scores;           // 5 traits with percentile scores
    mbtiType: string;                  // 4-letter MBTI type
    dominantTraits: string[];
    description: string;
  };
  personalityAnswers: Record<string, PersonalityAnswer>; // Complete response tracking
}

// ============================================================================
// FACIAL ANALYSIS TYPES
// ============================================================================

export interface FaceDetectionData {
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  imageDimensions: {
    width: number;
    height: number;
  };
}

export interface FacialLandmarkData {
  points: Array<{
    x: number;
    y: number;
    z?: number;
  }>;
  confidence: number;
  quality: number;
}

export interface AlignedFaceData {
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  alignmentScore: number;
  faceQuality: number;
}

export interface HeadPoseData {
  roll: number;
  pitch: number;
  yaw: number;
  confidence: number;
}

export interface EmotionScores {
  neutral: number;
  happiness: number;
  sadness: number;
  anger: number;
  fear: number;
  surprise: number;
  disgust: number;
  confidence: number;
  dominantEmotion: string;
}

export interface ProcessedFacialData {
  detectionMetrics: FaceDetectionData;
  landmarks68Points: FacialLandmarkData;
  unshiftedLandmarks: FacialLandmarkData;
  headPoseAngles: HeadPoseData;
  emotionAnalysis: EmotionScores;
  alignedRect: AlignedFaceData;
  
  // Generated analysis
  facialEmbedding: number[];
  microExpressions: MicroExpressionData[];
  stressIndicators: StressIndicator[];
  symmetryAnalysis: SymmetryAnalysis;
  emotionalComplexity: number;
  authenticityScore: number;
}

export interface MicroExpressionData {
  expressionType: string;
  duration: number;
  confidence: number;
  facialRegion: string;
  psychologicalSignificance: string;
  intensity: number;
}

export interface StressIndicator {
  indicatorType: string;
  severity: number;
  confidence: number;
  facialMarkers: string[];
  temporalPattern: string;
}

export interface SymmetryAnalysis {
  overallSymmetry: number;
  leftRightDeviation: number;
  verticalAlignment: number;
  facialProportions: {
    eyeDistance: number;
    eyeToNoseRatio: number;
    mouthToNoseRatio: number;
    facialThirds: number[];
  };
}

// ============================================================================
// VOICE ANALYSIS TYPES
// ============================================================================

export interface AudioData {
  data: ArrayBuffer | string; // Base64 encoded or raw audio data
  format: string;
  sampleRate?: number;
}

export interface DeviceInfo {
  platform: string;
  device: string;
  userAgent: string;
  audioCapabilities: {
    sampleRate: number;
    bitDepth: number;
    channels: number;
  };
}

export interface SpeechAnalysis {
  wordsPerMinute: number;
  averageVolume: number;
  silenceDuration: number;
  speechClarity: number;
  emotionalTone: string;
  confidenceLevel: number;
}

export interface ProcessedVoiceData {
  audioMetadata: {
    mimeType: string;
    duration: number;
    size: number;
    quality: number;
  };
  deviceInfo: DeviceInfo;
  speechProfile: SpeechProfile;
  
  // Generated analysis
  voiceEmbedding: number[];
  vocalStressProfile: VocalStressProfile;
  deviceImpactAssessment: DeviceImpactAssessment;
  speechCharacteristics: SpeechCharacteristics;
}

export interface SpeechProfile {
  speechCharacteristics: {
    wordsPerMinute: number;
    speechRateCategory: string;
    pauseFrequency: number;
    articulationClarity: number;
  };
  vocalEnergy: {
    averageVolume: number;
    dynamicRange: number;
    energyConsistency: number;
  };
  communicationStyle: {
    confidenceLevel: number;
    hesitationPatterns: string[];
    emphasisPatterns: string[];
  };
  stressIndicators: VocalStressIndicator[];
}

export interface VocalStressIndicator {
  indicatorType: string;
  severity: number;
  frequency: number;
  temporalPattern: string;
  confidence: number;
}

export interface VocalStressProfile {
  overallStressLevel: number;
  stressIndicators: VocalStressIndicator[];
  voiceStability: number;
  emotionalResonance: number;
}

export interface DeviceImpactAssessment {
  qualityImpact: number;
  compressionArtifacts: boolean;
  noiseLevel: number;
  frequencyResponse: {
    lowFrequency: number;
    midFrequency: number;
    highFrequency: number;
  };
  reliabilityScore: number;
}

export interface SpeechCharacteristics {
  linguisticComplexity: number;
  vocabularyRichness: number;
  sentenceStructure: string;
  communicationEffectiveness: number;
}

// ============================================================================
// IQ ASSESSMENT TYPES
// ============================================================================

export interface ProcessedIQData {
  rawResults: {
    rawScore: number;
    totalQuestions: number;
    iqScore: number;
    category: string;
    strengths: string[];
    description: string;
  };
  detailedAnswers: Record<string, string>;
  
  // Generated analysis
  cognitiveProfile: CognitiveProfile;
  problemSolvingProfile: ProblemSolvingProfile;
  learningStyleProfile: LearningStyleProfile;
  cognitiveEmbedding: number[];
  domainAnalysis: DomainAnalysis;
}

export interface CognitiveProfile {
  overallCognitiveScore: number;
  cognitiveDomains: {
    logicalReasoning: number;
    spatialIntelligence: number;
    verbalComprehension: number;
    workingMemory: number;
    processingSpeed: number;
  };
  cognitiveStrengths: string[];
  cognitiveWeaknesses: string[];
  learningPotential: number;
}

export interface ProblemSolvingProfile {
  approachStyle: string;
  strategicThinking: number;
  analyticalDepth: number;
  creativeSolution: number;
  persistenceLevel: number;
  errorPatterns: string[];
}

export interface LearningStyleProfile {
  preferredModality: 'visual' | 'auditory' | 'kinesthetic' | 'mixed';
  processingStyle: 'sequential' | 'global' | 'mixed';
  informationProcessing: 'concrete' | 'abstract' | 'balanced';
  learningPace: 'fast' | 'moderate' | 'deliberate';
  motivationalFactors: string[];
}

export interface DomainAnalysis {
  mathematicalReasoning: {
    score: number;
    strengths: string[];
    areas_for_growth: string[];
  };
  languageProcessing: {
    score: number;
    strengths: string[];
    areas_for_growth: string[];
  };
  spatialVisualization: {
    score: number;
    strengths: string[];
    areas_for_growth: string[];
  };
  logicalAnalysis: {
    score: number;
    strengths: string[];
    areas_for_growth: string[];
  };
}

// ============================================================================
// ASTROLOGICAL ANALYSIS TYPES
// ============================================================================

export interface WesternAstrologyData {
  sun: { sign: string; degree: number; house: number; };
  moon: { sign: string; degree: number; house: number; };
  rising: { sign: string; degree: number; };
  planets: Array<{
    name: string;
    sign: string;
    degree: number;
    house: number;
    retrograde?: boolean;
  }>;
  houses: Array<{
    number: number;
    sign: string;
    degree: number;
  }>;
  aspects: Array<{
    planet1: string;
    planet2: string;
    aspectType: string;
    orb: number;
    strength: number;
  }>;
}

export interface ChineseAstrologyData {
  animal: string;
  element: string;
  yinYang: 'yin' | 'yang';
  compatibility: {
    bestMatches: string[];
    challenges: string[];
  };
  lunarMonth: number;
  seasonalInfluence: string;
}

export interface AfricanAstrologyData {
  orisha: string;
  ancestralSpirit: string;
  tribalInfluence: string;
  seasonalAlignment: string;
  elementalConnection: string;
}

export interface NumerologyData {
  lifePathNumber: number;
  destinyNumber: number;
  soulUrgeNumber: number;
  personalityNumber: number;
  birthDateSignificance: string;
  nameVibration: number;
}

export interface AstrologicalSynthesis {
  dominantThemes: string[];
  lifeDirection: string;
  challenges: string[];
  opportunities: string[];
  spiritualPath: string;
  karmaticPatterns: string[];
}

export interface ProcessedAstrologicalData {
  western: WesternAstrologyData;
  chinese: ChineseAstrologyData;
  african: AfricanAstrologyData;
  numerology: NumerologyData;
  synthesis: AstrologicalSynthesis;
  
  // Generated analysis
  astrologicalEmbedding: number[];
  archetypalPatterns: ArchetypalPattern[];
  temporalInfluences: TemporalInfluence[];
  crossCulturalSynthesis: CrossCulturalSynthesis;
}

export interface ArchetypalPattern {
  archetype: string;
  strength: number;
  culturalOrigin: string;
  psychologicalSignificance: string;
  lifeAreaInfluence: string[];
}

export interface TemporalInfluence {
  timeFrame: string;
  influence: string;
  intensity: number;
  areaOfLife: string;
  guidance: string;
}

export interface CrossCulturalSynthesis {
  commonThemes: string[];
  culturalTensions: string[];
  integratedWisdom: string[];
  practicalApplications: string[];
}

// ============================================================================
// PERSONALITY ANALYSIS TYPES
// ============================================================================

export interface Big5Scores {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface PersonalityAnswer {
  questionId: string;
  response: string | number;
  confidence: number;
  responseTime?: number;
}

export interface ProcessedPersonalityData {
  big5Profile: Big5Scores;
  mbtiType: string;
  dominantTraits: string[];
  description: string;
  detailedAnswers: Record<string, PersonalityAnswer>;
  
  // Generated analysis
  personalityEmbedding: number[];
  behavioralTendencies: BehavioralTendency[];
  interpersonalStyle: InterpersonalStyle;
  stressResponsePatterns: StressResponsePattern[];
  motivationDrivers: MotivationDriver[];
  cognitiveProcessing: CognitiveProcessing;
}

export interface BehavioralTendency {
  behavior: string;
  likelihood: number;
  context: string[];
  triggers: string[];
  manifestations: string[];
}

export interface InterpersonalStyle {
  communicationStyle: string;
  conflictResolution: string;
  leadershipStyle?: string;
  teamRole: string;
  socialEnergy: number;
  empathyLevel: number;
}

export interface StressResponsePattern {
  stressType: string;
  typicalResponse: string;
  copingMechanisms: string[];
  effectiveness: number;
  recoveryTime: string;
}

export interface MotivationDriver {
  driver: string;
  strength: number;
  category: 'intrinsic' | 'extrinsic';
  lifeAreas: string[];
  sustainabilityFactor: number;
}

export interface CognitiveProcessing {
  decisionMakingStyle: string;
  informationProcessing: string;
  attentionPatterns: string;
  memoryStrengths: string[];
  learningPreferences: string[];
}

// ============================================================================
// PROCESSED MIRROR DATA (COMPLETE)
// ============================================================================

export interface ProcessedMirrorData {
  submissionId: string;
  userId: string;
  submissionTimestamp: Date;
  submissionType: 'complete_profile' | 'update_profile' | 'single_modality';
  
  // Processed modality data
  facialData: ProcessedFacialData;
  voiceData: ProcessedVoiceData;
  cognitiveData: ProcessedIQData;
  astrologicalData: ProcessedAstrologicalData;
  personalityData: ProcessedPersonalityData;
  
  // Cross-modal analysis
  modalityCorrelations: ModalityCorrelation[];
  dataQualityAssessment: DataQualityAssessment;
  processingMetadata: ProcessingMetadata;
}

export interface ModalityCorrelation {
  modality1: string;
  modality2: string;
  correlationType: 'positive' | 'negative' | 'neutral' | 'complex';
  strength: number;
  significance: number;
  description: string;
  confidence: number;
}

export interface DataQualityAssessment {
  overallQuality: number;
  modalityQuality: {
    facial: number;
    voice: number;
    cognitive: number;
    astrological: number;
    personality: number;
  };
  reliabilityScore: number;
  completenessScore: number;
  consistencyScore: number;
}

export interface ProcessingMetadata {
  processingVersion: string;
  processingTime: number;
  algorithmsUsed: string[];
  qualityChecks: QualityCheck[];
  errorFlags: string[];
  confidenceLevel: number;
}

export interface QualityCheck {
  checkType: string;
  passed: boolean;
  score?: number;
  details?: string;
}

// ============================================================================
// CONTEXT MANAGEMENT TYPES
// ============================================================================

export interface UserContext {
  userId: string;
  contextVersion: number;
  lastUpdated: Date;
  
  // Active context window
  activeContext: ContextWindow;
  contextSummary: string;
  
  // Context optimization metrics
  contextSizeTokens: number;
  compressionRatio: number;
  relevanceThreshold: number;
  
  // Pattern context
  activePatterns: PatternContext[];
  patternConfidence: Record<string, number>;
  
  // Temporal context
  temporalWindow: TemporalContext;
  temporalPatterns: TemporalPattern[];
  cyclicalInfluences: CyclicalInfluence[];
  
  // Cross-modal context
  modalityWeights: Record<string, number>;
  correlationMatrix: CorrelationMatrix;
  
  // User preferences and behavioral patterns
  userPreferences: UserPreferences;
  behavioralPatterns: BehavioralPattern[];
  feedbackHistory: FeedbackHistory[];
}

export interface ContextWindow {
  timeSpan: number; // in days
  submissions: SubmissionReference[];
  insights: InsightReference[];
  patterns: PatternReference[];
  keyEvents: ContextEvent[];
}

export interface SubmissionReference {
  submissionId: string;
  timestamp: Date;
  dataTypes: string[];
  importance: number;
  summary: string;
}

export interface InsightReference {
  insightId: string;
  timestamp: Date;
  insightType: string;
  confidence: number;
  userFeedback?: number;
  summary: string;
}

export interface PatternReference {
  patternId: string;
  patternType: string;
  strength: number;
  stability: string;
  firstDetected: Date;
  lastConfirmed: Date;
}

export interface ContextEvent {
  eventType: string;
  timestamp: Date;
  importance: number;
  description: string;
  relatedSubmissions: string[];
}

export interface PatternContext {
  patternId: string;
  patternType: string;
  currentStrength: number;
  trend: 'strengthening' | 'weakening' | 'stable';
  relevanceScore: number;
  lastUpdate: Date;
}

export interface TemporalContext {
  windowDays: number;
  granularity: 'daily' | 'weekly' | 'monthly';
  seasonalFactors: SeasonalFactor[];
  cyclicalPatterns: string[];
  timeSeriesData: TimeSeriesDataPoint[];
}

export interface TemporalPattern {
  patternType: string;
  frequency: string;
  strength: number;
  predictability: number;
  lastOccurrence: Date;
  nextPredicted?: Date;
}

export interface CyclicalInfluence {
  influenceType: string;
  cycle: string;
  currentPhase: string;
  impact: number;
  description: string;
}

export interface SeasonalFactor {
  season: string;
  influence: number;
  description: string;
  dataSupport: number;
}

export interface TimeSeriesDataPoint {
  timestamp: Date;
  value: number;
  metric: string;
  context?: string;
}

export interface CorrelationMatrix {
  [key: string]: number;
  facial_voice: number;
  facial_cognitive: number;
  facial_astrological: number;
  facial_personality: number;
  voice_cognitive: number;
  voice_astrological: number;
  voice_personality: number;
  cognitive_astrological: number;
  cognitive_personality: number;
  astrological_personality: number;
}

export interface UserPreferences {
  insightTypes: string[];
  notificationFrequency: string;
  analysisDepth: 'shallow' | 'medium' | 'deep';
  privacyLevel: 'minimal' | 'balanced' | 'maximum';
  communicationStyle: 'direct' | 'gentle' | 'encouraging';
  focusAreas: string[];
}

export interface BehavioralPattern {
  patternId: string;
  patternType: string;
  description: string;
  frequency: number;
  strength: number;
  confidence: number;
  firstObserved: Date;
  lastObserved: Date;
  triggers: string[];
  outcomes: string[];
}

export interface FeedbackHistory {
  feedbackId: string;
  timestamp: Date;
  feedbackType: string;
  targetType: string;
  targetId: string;
  rating?: number;
  textFeedback?: string;
  sentiment: number;
  incorporated: boolean;
}

// ============================================================================
// INSIGHT GENERATION TYPES
// ============================================================================

export interface MirrorInsight {
  insightId: string;
  userId: string;
  submissionId?: string;
  
  // Insight content
  insightText: string;
  insightSummary: string;
  insightType: InsightType;
  category: string;
  
  // Quality metrics
  confidenceScore: number;
  relevanceScore: number;
  noveltyScore: number;
  actionabilityScore: number;
  
  // Source information
  sourceModalities: string[];
  sourceDataIds: string[];
  contributingPatterns: string[];
  
  // Context
  temporalContext: any;
  crossModalCorrelations: any;
  patternReferences: any;
  
  // User interaction
  userFeedbackScore?: number;
  userFeedbackText?: string;
  feedbackTimestamp?: Date;
  
  // Metadata
  createdAt: Date;
  deliveredAt?: Date;
  readAt?: Date;
  processingTime: number;
  modelVersion: string;
}

export type InsightType = 
  | 'emotional_pattern'
  | 'cognitive_strength'
  | 'behavioral_tendency'
  | 'cross_modal_correlation'  
  | 'temporal_trend'
  | 'astrological_influence'
  | 'personality_manifestation'
  | 'growth_opportunity'
  | 'potential_challenge'
  | 'life_direction'
  | 'relationship_pattern'
  | 'stress_indicator'
  | 'wellness_recommendation';

export interface QuickInsight {
  type: InsightType;
  title: string;
  summary: string;
  confidence: number;
  actionable: boolean;
  priority: 'high' | 'medium' | 'low';
}

export interface DetailedInsight extends MirrorInsight {
  supportingEvidence: Evidence[];
  relatedInsights: string[];
  recommendations: Recommendation[];
  followUpQuestions: string[];
}

export interface Evidence {
  source: string;
  dataPoint: string;
  strength: number;
  description: string;
}

export interface Recommendation {
  recommendationType: string;
  description: string;
  priority: number;
  expectedOutcome: string;
  timeframe: string;
}

// ============================================================================
// PATTERN DETECTION TYPES
// ============================================================================

export interface DetectedPattern {
  patternId: string;
  userId: string;
  submissionId?: string;
  
  // Pattern identification
  patternType: PatternType;
  patternName: string;
  description: string;
  
  // Pattern characteristics
  sourceModalities: string[];
  correlationStrength: number;
  statisticalSignificance: number;
  confidence: number;
  
  // Pattern data
  patternData: any;
  supportingEvidence: any;
  
  // Temporal aspects
  stability: PatternStability;
  firstDetected: Date;
  lastConfirmed: Date;
  occurrenceFrequency: number;
  
  // Insights and implications
  psychologicalSignificance: string;
  behavioralImplications: any;
  developmentRecommendations: string[];
  
  // Metadata
  detectionMethod: string;
  algorithmVersion: string;
  processingTime: number;
}

export type PatternType = 
  | 'correlation'
  | 'contradiction'
  | 'reinforcement'
  | 'emergence'
  | 'cyclical'
  | 'progressive'
  | 'regressive';

export type PatternStability = 
  | 'stable'
  | 'emerging'
  | 'declining'
  | 'cyclical'
  | 'volatile';

export interface CrossModalPattern extends DetectedPattern {
  involvedModalities: string[];
  correlationMatrix: Record<string, number>;
  interactionType: 'synergistic' | 'contradictory' | 'complementary' | 'neutral';
  emergentProperties: string[];
}

export interface TemporalPatternData {
  patternId: string;
  timeSeriesData: TimeSeriesDataPoint[];
  frequency: string;
  amplitude: number;
  phase: number;
  trend: 'increasing' | 'decreasing' | 'stable' | 'cyclical';
  seasonality?: SeasonalComponent[];
}

export interface SeasonalComponent {
  period: string;
  amplitude: number;
  phase: number;
  confidence: number;
}

// ============================================================================
// STORAGE AND RETRIEVAL TYPES
// ============================================================================

export interface StorageRequest {
  userId: string;
  dataType: string;
  data: any;
  encryptionRequired: boolean;
  tier: 'tier1' | 'tier2' | 'tier3';
  metadata?: StorageMetadata;
}

export interface StorageMetadata {
  contentType: string;
  size: number;
  checksum: string;
  createdAt: Date;
  expiresAt?: Date;
  accessLevel: string;
  tags: string[];
}

export interface RetrievalRequest {
  userId: string;
  dataType?: string;
  dataId?: string;
  filters?: RetrievalFilters;
  pagination?: PaginationOptions;
}

export interface RetrievalFilters {
  dateRange?: { start: Date; end: Date; };
  dataTypes?: string[];
  minConfidence?: number;
  maxResults?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginationOptions {
  page: number;
  pageSize: number;
  offset?: number;
  limit?: number;
}

export interface StorageResult {
  success: boolean;
  dataId?: string;
  error?: string;
  metadata?: StorageMetadata;
}

export interface RetrievalResult<T = any> {
  success: boolean;
  data?: T[];
  totalCount?: number;
  error?: string;
  metadata?: {
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  };
}

// ============================================================================
// NOTIFICATION TYPES
// ============================================================================

export interface NotificationRequest {
  userId: string;
  notificationType: NotificationType;
  priority: 'high' | 'medium' | 'low';
  content: NotificationContent;
  deliveryPreferences?: DeliveryPreferences;
  scheduledFor?: Date;
  expiresAt?: Date;
}

export type NotificationType = 
  | 'insight_ready'
  | 'analysis_complete'
  | 'pattern_detected'
  | 'questions_available'
  | 'feedback_request'
  | 'system_update'
  | 'data_processed';

export interface NotificationContent {
  title: string;
  message: string;
  actionUrl?: string;
  previewData?: any;
  attachments?: NotificationAttachment[];
}

export interface NotificationAttachment {
  type: string;
  name: string;
  url: string;
  size?: number;
}

export interface DeliveryPreferences {
  pushNotification: boolean;
  inAppNotification: boolean;
  emailSummary: boolean;
  smsAlert?: boolean;
  preferredTime?: string;
}

export interface NotificationResult {
  notificationId: string;
  success: boolean;
  deliveredAt?: Date;
  error?: string;
  deliveryChannels: string[];
}

// ============================================================================
// ERROR AND PERFORMANCE TYPES
// ============================================================================

export interface MirrorError {
  errorCode: string;
  errorType: MirrorErrorType;
  message: string;
  details?: any;
  timestamp: Date;
  userId?: string;
  submissionId?: string;
  stackTrace?: string;
}

export type MirrorErrorType = 
  | 'validation_error'
  | 'processing_error'
  | 'storage_error'
  | 'context_error'
  | 'insight_generation_error'
  | 'notification_error'
  | 'pattern_detection_error'
  | 'system_error';

export interface ErrorRecoveryAction {
  actionType: string;
  description: string;
  automated: boolean;
  priority: number;
}

export interface PerformanceMetric {
  operation: string;
  duration: number;
  success: boolean;
  timestamp: Date;
  userId?: string;
  submissionId?: string;
  error?: string;
  metadata?: any;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  uptime: number;
  activeProcessing: number;
  queueDepth: Record<string, number>;
  performanceMetrics: Record<string, {
    average: number;
    min: number;
    max: number;
    count: number;
  }>;
  errorRate: number;
  lastChecked: Date;
}

export interface ResourceUsage {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  networkUsage: number;
  databaseConnections: number;
  redisConnections: number;
  activeWebSockets: number;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface MirrorModuleConfig {
  processing: {
    maxConcurrentSubmissions: number;
    processingTimeout: number;
    retryAttempts: number;
    immediateInsightTimeout: number;
    deepAnalysisTimeout: number;
  };
  storage: {
    defaultTier: 'tier1' | 'tier2' | 'tier3';
    encryptionAlgorithm: string;
    compressionEnabled: boolean;
    backupRetention: number;
  };
  context: {
    defaultWindowDays: number;
    maxContextSize: number;
    compressionThreshold: number;
    relevanceThreshold: number;
  };
  insights: {
    minConfidenceThreshold: number;
    maxInsightsPerSubmission: number;
    insightExpirationDays: number;
  };
  notifications: {
    defaultChannels: string[];
    retryAttempts: number;
    batchSize: number;
  };
  performance: {
    metricsRetention: number;
    healthCheckInterval: number;
    performanceThresholds: {
      warning: number;
      critical: number;
    };
  };
}

// ============================================================================
// FIXED: NO DUPLICATE EXPORTS - SINGLE SOURCE OF TRUTH
// ============================================================================

// NOTE: All types are already exported above with individual export statements
// No need for redundant export lists that cause conflicts

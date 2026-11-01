export const he = {
  appName: "מלולי",
  genericError: "משהו השתבש. אפשר לנסות שוב.",
  localModelMissingError: "מנוע התמלול עדיין לא הורד.",
  whisperMissing: "מנוע התמלול לא הותקן עד הסוף. אפשר להוריד אותו מחדש בהגדרות.",
  transcriptionAlreadyRunning: "כבר מתבצע תמלול.",
  transcriptionCanceled: "התמלול בוטל.",
  transcriptionProcessFailed: "התמלול לא הושלם. אפשר לנסות שוב.",
  recordingCanceled: "ההקלטה בוטלה",
  recordingHeld: "ההקלטה עדיין כאן",
  recordingHeldExpired: "ההקלטה שנשמרה זמנית נמחקה אחרי 10 דקות.",
  recordingInterrupted: "המק נכנס לשינה, אז ההקלטה נעצרה. היא שמורה כאן ל־10 דקות.",
  microphoneOpenedTooLate: "המיקרופון עוד לא נפתח, אז שום דבר לא הוקלט. אפשר לנסות שוב.",
  recordingTooShort: "נקלט רק רגע קצר, אז אין מה לתמלל. אפשר לנסות שוב.",
  microphoneDisconnected: "המיקרופון התנתק, אז ההקלטה נעצרה. מה שהוקלט עד אז נשמר.",
  quitLosesDictation: "יש הכתבה שעדיין לא נשמרה",
  quitLosesDictationDetail: "יציאה עכשיו תמחק את ההקלטה הזו.",
  keepDictation: "להישאר",
  quitAnyway: "יציאה בכל זאת",
  undo: "שחזור",
  undoWithShortcut: "שחזור (⌘Z)",
  retryTranscription: "תמלול מחדש",
  transcriptionEmptyResult: "לא זוהה דיבור. אפשר לנסות שוב, ואם זה חוזר, לבדוק את המיקרופון בהגדרות.",
  transcriptionInvalidOutput: "התמלול הפיק טקסט פגום, ולכן לא הודבק דבר. אפשר להקליט שוב.",
  modelDownloadFailed: "הורדת מנוע התמלול נכשלה. כדאי לבדוק את החיבור לאינטרנט ולנסות שוב.",
  modelDownloadRedirectLoop: "הורדת המנוע נכשלה בגלל יותר מדי הפניות.",
  modelDownloadRedirectFailed: "הורדת המנוע נכשלה בגלל קישור הפניה לא תקין.",
  modelDownloadEmptyFile: "ההורדה הושלמה, אבל לא התקבל קובץ תקין.",
  audioConversionFailed: "לא הצלחנו לקרוא את קובץ השמע. אפשר לנסות קובץ m4a, mp3 או wav.",
  recordingNotStarted: "ההקלטה עדיין לא התחילה.",
  recordingFailed: "לא הצלחנו להתחיל את ההקלטה. כדאי לבדוק שהמיקרופון מחובר ולנסות שוב.",
  stopRecordingFailed: "לא הצלחנו לעצור את ההקלטה.",
  pauseRecordingFailed: "לא הצלחנו להשהות את ההקלטה.",
  resumeRecordingFailed: "לא הצלחנו להמשיך את ההקלטה.",
  importAudioFailed: "לא הצלחנו לייבא את הקובץ. אפשר לנסות קובץ m4a, mp3 או wav.",
  youtubeImportFailed: "לא הצלחנו לתמלל את הקישור. כדאי לבדוק שהתוכן זמין ולנסות שוב.",
  youtubeDownloadFailed: "לא הצלחנו להוריד את השמע מהקישור. ייתכן שהתוכן פרטי או דורש התחברות.",
  linkUnsupportedSite: "האתר הזה לא נתמך. אפשר לנסות קישור מאתר אחר.",
  youtubeCanceled: "הורדת השמע בוטלה.",
  youtubeImportAlreadyRunning: "כבר מורידים שמע מקישור.",
  shortcutRegisterFailed: "הצירוף הזה תפוס או לא נתמך. אפשר לבחור צירוף אחר.",
  shortcutConflict: "שני קיצורי הדרך צריכים להיות שונים.",
  shortcutNeedsModifier: "צריך צירוף עם ⌘, ⌃ או ⌥ ועוד מקש.",
  shortcutEditHint: "לוחצים עכשיו על הצירוף החדש.",
  textInsertionFailed: "לא הצלחנו להדביק את התמלול לשדה הפעיל.",
  textInsertionTargetUnavailable: "השדה המקורי אינו זמין. אפשר להעתיק את התמלול ולהדביק ידנית.",
  textInsertionUnsupported: "הדבקה ישירה לשדה הפעיל זמינה כרגע רק ב-macOS.",
  accessibilityPermissionNeeded: "כדי להדביק לשדות באפליקציות אחרות צריך לאשר גישת נגישות.",
  pasteIntoApp: (app: string | null) => app ? `הדבקה ב־${app}` : "הדבקה",
  textInsertionTargetChanged: "המיקוד עבר לחלון אחר, אז התמלול לא הודבק. הוא שמור כאן.",
  textInsertionSecureField: "זה שדה מוגן, אז התמלול לא הודבק. אפשר להעתיק אותו.",
  textInsertionClipboardChanged: "הלוח השתנה בזמן ההדבקה, אז התמלול לא הודבק. הוא שמור כאן.",
  transcriptReadyInApp: "התמלול מוכן. אפשר להעתיק אותו.",
  allowMicrophone: "אישור גישה למיקרופון",
  accessibility: "גישת נגישות",
  allowAccessibility: "אישור גישת נגישות",
  accessibilityDescription: "מאפשרת להדביק את התמלול לשדה הפעיל באפליקציות אחרות.",
  completionNotifications: "התראות על תמלול ארוך",
  completionNotificationsDescription: "התראה כשתמלול ארוך מסתיים ומלולי ברקע.",
  completionNotificationTitle: "התמלול הארוך מוכן",
  completionNotificationBody: "התמלול הסתיים ומוכן לעיון.",
  downloadHebrewModel: "הורדת מנוע התמלול",
  bytesDownloadedSuffix: "הורדו",
  general: "כללי",
  transcription: "תמלול",
  storage: "אחסון",
  stepMicrophone: "מיקרופון",
  stepHoldKey: "מקש ההכתבה",
  stepModel: "מנוע התמלול",
  stepReady: "מוכנים",
  launchAtLoginDescription: "מלולי נפתחת ברקע כשנכנסים למחשב.",
  microphoneDescription: "מלולי מאזינה רק בזמן הקלטה.",
  removeFillerWords: "הסרת מילות מילוי",
  removeFillerWordsDescription: 'בלי "אה", "אממ", "כאילו" וחזרות מיידיות.',
  spokenCommands: "פקודות דיבור",
  spokenCommandsDescription: 'אומרים "סימן שאלה", "פסיק", "נקודה", "מקף" או "שורה חדשה", ומקבלים את הסימן עצמו.',
  autoUpdate: "עדכונים אוטומטיים",
  autoUpdateDescription: "מלולי בודקת אם יצאה גרסה חדשה ומורידה אותה ברקע. הקול והטקסט לא נשלחים.",
  updateDownloading: "מורידים גרסה חדשה…",
  updateReady: "הגרסה החדשה מוכנה ותותקן בהפעלה הבאה.",
  updateFailed: "העדכון לא הצליח. ננסה שוב מאוחר יותר.",
  updateInstall: "הפעלה מחדש ועדכון",
  builtInTerms: "מונחים באנגלית",
  builtInTermsDescription: "קלוד אמדי נכתב CLAUDE.md. המקור נשמר בכל תמלול.",
  dictionaryTitle: "מילון",
  dictionaryPersonal: "התיקונים שלך",
  dictionaryPersonalDescription: "המילה כפי שהמודל כותב אותה, ואיך היא צריכה להיכתב.",
  dictionaryHeard: "המודל כותב",
  dictionaryWritten: "צריך להיות",
  dictionaryAdd: "הוספה",
  dictionaryEmpty: "עדיין אין תיקונים.",
  dictionaryDuplicate: "יש כבר תיקון למילה הזו.",
  dictionaryFull: "המילון מלא. מחקו תיקון כדי להוסיף חדש.",
  modelMissing: "מנוע התמלול עדיין לא הורד",
  modelDownloading: "מורידים את מנוע התמלול",
  idle: "מוכנים",
  recording: "מקליטים",
  paused: "בהשהיה",
  processing: "מתמללים",
  error: "שגיאה",
  startRecording: "התחלת הקלטה",
  pauseRecording: "השהיה",
  resumeRecording: "המשך הקלטה",
  stopRecording: "עצירת הקלטה",
  importAudio: "ייבוא קובץ",
  youtubeLabel: "קישור",
  youtubeHint: "תוכן שמותר להוריד",
  supportedSitesLabel: "אילו אתרים נתמכים",
  supportedSitesTitle: "עובד עם מאות אתרים, למשל:",
  supportedSitesNote: "תוכן פרטי או כזה שדורש התחברות לא יירד. TikTok ו-Vimeo לפעמים חוסמים הורדה.",
  supportedSitesAll: "לרשימה המלאה",
  youtubeSubmit: "תמלול קישור",
  youtubeUrlPlaceholder: "מדביקים קישור",
  youtubeInvalidUrl: "צריך קישור מלא מסוג https לסרטון או לשמע יחיד.",
  youtubeQueued: "בתור",
  youtubeQueuedHint: "הקישור בתור. התמלול יתחיל כשהפעולה הנוכחית תסתיים.",
  youtubeCancelPending: "ביטול ההמתנה",
  trayDownloading: "מורידים",
  trayStartRecording: "התחלת הקלטה",
  trayStopAndTranscribe: "עצירה ותמלול",
  trayCancelProcessing: "ביטול התמלול",
  youtubeTranscribing: "מתמללים מהקישור",
  youtubeDownloaderMissing: "רכיב ההורדה חסר.",
  youtubeFallbackTitle: "תמלול מקישור",
  youtubeMockTitle: "כותרת הסרטון",
  openOriginal: "פתיחת המקור",
  history: "היסטוריה",
  settings: "הגדרות",
  workspace: "בית",
  mainNavigation: "ניווט ראשי",
  about: "אודות",
  termsOfUse: "תנאי שימוש",
  privacy: "פרטיות",
  thirdPartyLicenses: "רישיונות צד שלישי",
  sourceCode: "קוד המקור",
  legalLastUpdated: "עודכן לאחרונה: 1 בנובמבר 2026",
  aboutPageTitle: "אודות מלולי",
  aboutPageSections: [
    {
      paragraphs: [
        "מלולי היא אפליקציית הכתבה ותמלול בעברית ל-Mac. לוחצים על קיצור מקלדת, מדברים, והטקסט מופיע במקום שבו עובדים.",
        "התמלול רץ על המחשב, בלי חשבון ובלי פרסום. הקלטות, קבצים ותמלולים נשארים אצלכם. רשת נדרשת רק להורדת מנוע התמלול ולשמע מקישורים.",
        "זו גרסת Preview שעדיין בפיתוח, ולכן ייתכנו בה תקלות ושינויים."
      ]
    },
    {
      title: "תודות",
      paragraphs: [
        "התמלול מבוסס על מודל Whisper של OpenAI בכוונון לעברית של ivrit.ai, בגרסה שפרסם JoaoZaokk, ורץ על whisper.cpp. שמע מקישורים מורד באמצעות yt-dlp, והממשק בנוי על Electron ו-React."
      ]
    },
    {
      title: "יוצרים ורישיון",
      paragraphs: [
        "מלולי נוצרה על ידי Jonathan Rashi. קוד האפליקציה מופץ ברישיון MIT.",
        "מודלים, ספריות, כלים וסמלים של צד שלישי נשארים כפופים לתנאים שלהם."
      ]
    }
  ],
  termsPageTitle: "תנאי שימוש",
  termsPageSections: [
    {
      paragraphs: [
        "התנאים האלה חלים על השימוש באפליקציית מלולי. השימוש באפליקציה מהווה הסכמה להם."
      ]
    },
    {
      title: "רישיון",
      paragraphs: [
        "קוד האפליקציה מופץ ברישיון MIT, ובכל הנוגע לקוד רישיון זה גובר על התנאים האלה. השם, הלוגו והאיורים של מלולי אינם כלולים בו.",
        "מודלים, ספריות, כלים וסמלים של צד שלישי כפופים לתנאים שלהם, המפורטים ברישיונות צד שלישי בעמוד האודות."
      ]
    },
    {
      title: "גרסת Preview",
      paragraphs: [
        "מלולי נמצאת בפיתוח וניתנת כפי שהיא (AS IS) וכפי שהיא זמינה, בלי אחריות מכל סוג, לרבות לדיוק, לזמינות, להתאמה למטרה מסוימת או להיעדר תקלות. תכונות עשויות להשתנות או להיעלם."
      ]
    },
    {
      title: "דיוק התמלול",
      paragraphs: [
        "תמלול אוטומטי עלול להשמיט מילים, לשנות משמעות ולשבש שמות ומספרים. האחריות לבדוק את הטקסט לפני שמשתמשים בו או שולחים אותו היא שלכם, ובמיוחד בהקשר רפואי, משפטי, פיננסי או בטיחותי. מלולי אינה תחליף לתמלול מוסמך או לייעוץ מקצועי.",
        "הטקסט מודבק בשדה שהיה פעיל. לפני ששולחים הודעה או מסמך, כדאי לוודא שהטקסט הגיע למקום הנכון."
      ]
    },
    {
      title: "הקלטת שיחות",
      paragraphs: [
        "מלולי לא מודיעה למשתתפים בשיחה שהיא מוקלטת. האחריות לעדכן אותם, לקבל הסכמה כשנדרשת ולעמוד בחוק החל עליכם היא שלכם. הדין בנוגע להקלטת שיחות משתנה ממקום למקום.",
        "הקלטה שנמשכת אחרי שיצאתם מהשיחה עלולה להיות האזנת סתר, ולכן יש לעצור אותה כשאתם יוצאים."
      ]
    },
    {
      title: "הקלטות ותוכן",
      paragraphs: [
        "האחריות לתוכן שאתם מקליטים, מייבאים ומתמללים היא שלכם. מקליטים ומתמללים אנשים אחרים רק כשהדין מתיר זאת, ומקבלים את הסכמתם כשהיא נדרשת. בישראל, למשל, אסור להקליט שיחה שאינכם צד לה בלי הסכמה של אף אחד מהמשתתפים בה, ובמקומות אחרים הכללים עשויים להיות מחמירים יותר.",
        "אין להשתמש במלולי לפעולה בלתי חוקית, לפגיעה בפרטיות או בזכויות של אחרים, או למעקב אחר אדם בלי ידיעתו."
      ]
    },
    {
      title: "ייבוא מקישורים",
      paragraphs: [
        "ייבוא מקישור מוריד שמע מאתר חיצוני באמצעות הכלי yt-dlp. מייבאים רק תוכן שמותר לכם להוריד ולתמלל, בהתאם לזכויות היוצרים ולתנאי האתר. תנאיהם של אתרים מסוימים, ובהם YouTube, עשויים לאסור הורדה ללא אישור. מלולי אינה מעניקה זכות כלשהי בתוכן הזה."
      ]
    },
    {
      title: "הנתונים שלכם",
      paragraphs: [
        "התמלולים נשמרים על המחשב שלכם, ומלולי לא מגבה אותם בשבילכם. האחריות לגיבוי היא שלכם. פרטים נוספים מופיעים בעמוד הפרטיות."
      ]
    },
    {
      title: "הגבלת אחריות",
      paragraphs: [
        "במידה המרבית שהדין מתיר, היוצרים והתורמים למלולי לא יהיו אחראים לנזק ישיר או עקיף, לאובדן נתונים, מידע או הכנסות, או לתוצאה של שימוש בתמלול, גם אם ידעו שנזק כזה אפשרי. האמור כאן אינו גורע מזכויות שלפי הדין אי אפשר לוותר עליהן."
      ]
    },
    {
      title: "סימנים מסחריים",
      paragraphs: [
        "Apple, Mac, macOS, YouTube, Google Meet, Zoom, Microsoft Teams, OpenAI, Whisper, ivrit.ai ושמות אחרים המוזכרים כאן שייכים לבעליהם ומשמשים רק לתיאור תאימות. מלולי היא פרויקט עצמאי, ואין לה קשר, חסות או אישור מצד הבעלים האלה."
      ]
    },
    {
      title: "שינויים ודין חל",
      paragraphs: [
        "התנאים עשויים להשתנות בגרסאות חדשות. הנוסח החל הוא זה שמופיע בגרסה שבה אתם משתמשים.",
        "על התנאים חל הדין הישראלי, וסמכות השיפוט נתונה לבתי המשפט המוסמכים בישראל, בלי לגרוע מזכויות צרכן שאי אפשר לוותר עליהן."
      ]
    }
  ],
  privacyPageTitle: "מדיניות פרטיות",
  privacyPageSections: [
    {
      paragraphs: [
        "מלולי לא שולחת הקלטות, תמלולים או מילון לשום שרת. אין בה חשבון או פרסום, והיא לא אוספת נתוני שימוש או דיווחי קריסה. ליוצרי מלולי אין גישה למידע שלכם.",
        "הדברים נכונים לקוד המקורי של מלולי. גרסה ששונתה בידי אחרים עשויה לפעול אחרת."
      ]
    },
    {
      title: "מה נשמר על המחשב",
      paragraphs: [
        "התמלולים, המילון, ההגדרות ומנוע התמלול נשמרים בתיקיית הנתונים של האפליקציה. ההיסטוריה יכולה לכלול את טקסט התמלול, כותרות וקישורים של מקורות, מקטעי זמן ומדדי זמן עיבוד.",
        "מלולי לא מצפינה את הקבצים האלה בעצמה. ההגנה עליהם תלויה בחשבון המשתמש ובהצפנת הדיסק של macOS (FileVault)."
      ]
    },
    {
      title: "הקלטות",
      paragraphs: [
        "קובצי הקלטה והמרה זמניים נמחקים בסיום העבודה. אחרי תמלול שנכשל השמע נשאר בזיכרון עשר דקות כדי לאפשר ניסיון נוסף, ואחרי ביטול הקלטה שש שניות כדי לאפשר שחזור. הוא לא נכתב אז לדיסק.",
        "קריסה או הפסקת חשמל עלולות להשאיר קובץ זמני, שיימחק בהפעלה שאחרי שש שעות. קבצים מקוריים שייבאתם לא נמחקים."
      ]
    },
    {
      title: "שיחות",
      paragraphs: [
        "ההצעות לתמלל שיחות כבויות עד שמפעילים אותן בהגדרות. כשהן פועלות, ב־macOS 14.2 ואילך, מלולי בודקת אילו אפליקציות משתמשות במיקרופון וברמקולים. הבדיקה לא קוראת שמע ולא נשמרת.",
        "שום דבר לא מוקלט בלי לחיצה שלכם. מלולי לא מצטרפת לשיחה ולא מודיעה למשתתפים. בזמן הקלטה המיקרופון ושמע אפליקציית השיחה נשמרים בשני קבצים בתיקיית הנתונים, והמיקרופון מוקלט גם כשמושתקים בשיחה. בשיחה בדפדפן מוקלט גם צליל של לשוניות אחרות באותו דפדפן.",
        "התמלול נעשה על המחשב, ומלולי לא שולחת שמע או טקסט לשום שרת. גיבוי, סנכרון או לוח משותף שהפעלתם עשויים להעתיק מידע מהמחשב. הקבצים נמחקים אחרי שהתמלול נשמר. אם התמלול נכשל הם נשארים עד שתנסו שוב או תמחקו אותם."
      ]
    },
    {
      title: "מחיקה",
      paragraphs: [
        "מחיקת תמלול מסירה אותו מההיסטוריה, ו\"איפוס הכול\" מוחק את מנוע התמלול, את כל התמלולים ואת המילון. עותקי טקסט וגיבויי מסד נתונים עשויים להישאר בתיקיית הנתונים, ואפשר למחוק אותם ידנית דרך \"פתיחת התיקייה\" בהגדרות. קבצים שייצאתם נשארים במקום שבו שמרתם אותם."
      ]
    },
    {
      title: "הרשאות",
      paragraphs: [
        "מיקרופון: להקלטה. הקלטת שמע: רק לשמע של אפליקציית השיחה, ומתבקשת בפעם הראשונה שמקליטים שיחה. נגישות: כדי לחזור לתוכנה שבה עבדתם, לבצע הדבקה ולוודא שהיא הצליחה. ניטור קלט: רק ללחיצה ממושכת להקלטה. רכיב קטן עוקב אחרי מקשי השינוי ומדווח אם המקש שבחרתם לחוץ, ואינו מקבל הקשות."
      ]
    },
    {
      title: "שדה הטקסט והלוח",
      paragraphs: [
        "כדי להדביק בבטחה, מלולי קוראת את הטקסט שבשדה הפעיל כשהקלטה מתחילה, כשהחלון הצף מאבד מיקוד בזמן המתנה וסביב ההדבקה. שדות מאובטחים, כמו סיסמאות, לא נקראים. הטקסט נשמר בזיכרון בלבד עד שמשתמשים בו או מחליפים אותו, ובגרסה רגילה לא נכתב לדיסק או ליומן.",
        "לפני ההדבקה תוכן הלוח נשמר בזיכרון, ואחריה הוא משוחזר, אלא אם העתקתם בינתיים משהו חדש. קריסה עלולה למנוע את השחזור."
      ]
    },
    {
      title: "מתי יש חיבור לרשת",
      paragraphs: [
        "הורדת מנוע התמלול: הקבצים מורדים מ-Hugging Face ונבדקים מול גודל ו-SHA-256 קבועים מראש. השירות רואה פרטי בקשה רגילים, כמו כתובת IP.",
        "ייבוא מקישור: מלולי פונה לאתר שהדבקתם ולשרתי המדיה שלו, והשמע מתומלל על המחשב. האתר רואה את הקישור ופרטי בקשה רגילים, כמו כתובת IP.",
        "עדכונים אוטומטיים, כשהם זמינים ומופעלים: מלולי מורידה קובץ גרסה וחבילת עדכון, ושרת ההפצה רואה פרטי בקשה רגילים. אפשר לכבות אותם בהגדרות.",
        "קישורי מידע נפתחים בדפדפן. כל השירותים האלה פועלים לפי מדיניות הפרטיות שלהם."
      ]
    },
    {
      title: "שינויים",
      paragraphs: [
        "אם התנהגות האפליקציה תשתנה, העמוד הזה יתעדכן. תכונה שתשלח הקלטות או תמלולים לשירות חיצוני, אם תתווסף, תהיה בחירה שלכם ותפורט כאן מראש."
      ]
    }
  ],
  noTranscriptYet: "בוחרים תמלול מהרשימה.",
  copy: "העתקה",
  downloadSrt: "כתוביות SRT",
  copied: "הועתק",
  delete: "מחיקה",
  revealStorage: "פתיחת התיקייה",
  rerunOnboarding: "הפעלת ההיכרות מחדש",
  rerunOnboardingDescription: "מציג שוב את שלבי ההגדרה. התמלולים נשארים.",
  settingsResetEverything: "איפוס הכול",
  settingsResetEverythingDescription: "מוחק את מנוע התמלול ואת כל התמלולים ומחזיר את מלולי להתחלה. ההרשאות נשארות.",
  settingsResetConfirmTitle: "לאפס הכול?",
  settingsResetConfirmBody: "מנוע התמלול וכל התמלולים יימחקו, וההיכרות תתחיל מחדש.",
  settingsResetConfirmButton: "איפוס הכול",
  settingsResetCancel: "ביטול",
  retry: "ניסיון נוסף",
  microphone: "מיקרופון",
  microphoneInput: "מיקרופון להקלטה",
  microphoneSelectionDescription: "הקלטות מהאפליקציה ומהחלון הצף משתמשות בו.",
  systemMicrophone: "מיקרופון המערכת",
  microphoneUnavailable: "המיקרופון שנבחר לא זמין",
  permissionNeeded: "נדרשת הרשאת מיקרופון",
  onboardingWelcomeTitle: "פשוט לדבר.",
  onboardingWelcomeBody: "מדברים בעברית, והטקסט מופיע איפה שהסמן עומד, בכל אפליקציה.",
  onboardingMicrophoneTitle: "נשמע אותך רגע.",
  onboardingMicrophoneBody: "כמה מילים מספיקות כדי לראות שהמיקרופון עובד. הבדיקה לא נשמרת.",
  onboardingMicrophoneAction: "בדיקת המיקרופון",
  onboardingHoldKeyTitle: "מחזיקים, מדברים, משחררים.",
  onboardingHoldKeyBody: "מחזיקים מקש אחד בזמן הדיבור, ובשחרור הטקסט נכנס לשדה.",
  holdKeyLabel: "הכתבה בהחזקת מקש",
  holdKeyDescription: "מחזיקים את המקש ומדברים. בשחרור הטקסט נכנס לשדה.",
  holdKeyInput: "מקש להחזקה",
  holdKeyOff: "כבוי",
  holdKeyRightOption: "Option ימני",
  holdKeyRightCommand: "Command ימני",
  holdKeyAllow: "אישור ניטור קלט",
  holdKeyOpenSettings: "פתיחת הגדרות המערכת",
  holdKeyPermissionNeeded: "צריך לאשר את מלולי תחת ניטור קלט בהגדרות המערכת. macOS יציע לפתוח אותה מחדש, וממשיכים מאותו מקום.",
  holdKeyUnavailable: "המקש לא זמין כרגע. הקיצור הרגיל ממשיך לעבוד.",
  holdKeyChecking: "בודקים את המקש…",
  holdKeyOffMessage: "אפשר להפעיל בכל רגע בהגדרות.",
  holdKeyTryIt: "אפשר להחזיק את המקש ולראות שהוא נקלט",
  holdKeyWorks: "המקש עובד",
  holdKeyPrivacy: "רק המקש הזה. שום הקשה אחרת לא מגיעה למלולי.",
  onboardingModelBody: "מורידים פעם אחת. בזמן ההורדה כבר אפשר להיכנס.",
  onboardingInstallAction: "הורדה והמשך",
  onboardingQuickSetup: "הגדרה ראשונה",
  onboardingStepOfTotal: "שלב {current} מתוך {total}",
  onboardingStartSetup: "נתחיל",
  onboardingContinueLater: "נמשיך אחר כך",
  onboardingResumeSetup: "חזרה להיכרות",
  onboardingFirstTranscriptTitle: "עכשיו תמלול ראשון",
  onboardingFirstTranscriptLead: "לוחצים",
  onboardingFirstTranscriptBody: "כאן או בכל אפליקציה אחרת, מדברים ולוחצים שוב. הטקסט יופיע איפה שהסמן עומד.",
  onboardingAccessibilityHint: "כדי להדביק באפליקציות אחרות, צריך לאשר פעם אחת גישת נגישות.",
  onboardingModelTitle: "עברית, גם בלי אינטרנט.",
  onboardingModelErrorHint: "ההורדה לא הושלמה.",
  continue: "המשך",
  back: "חזרה",
  downloadInProgress: "מורידים…",
  modelReady: "מנוע התמלול מוכן",
  recordingShortcutLabel: "קיצור דרך להקלטה",
  recordingShortcutDescription: "מתחיל או עוצר הקלטה מכל אפליקציה, והטקסט מודבק בשדה הפעיל.",
  overlayPositionLabel: "מיקום החלון הצף",
  overlayPositionDescription: "איפה החלון נפתח בכל הקלטה.",
  overlayPositions: {
    last: "איפה שהשארתי אותו",
    top: "למעלה במרכז",
    bottom: "למטה במרכז",
    right: "בצד ימין",
    left: "בצד שמאל",
    "top-right": "פינה ימנית עליונה",
    "top-left": "פינה שמאלית עליונה",
    "bottom-right": "פינה ימנית תחתונה",
    "bottom-left": "פינה שמאלית תחתונה"
  },
  overlayShortcutLabel: "קיצור דרך לחלון הצף",
  overlayShortcutDescription: "מתחיל הקלטה בחלון הצף. לחיצה נוספת עוצרת אותה.",
  launchAtLogin: "פתיחה עם הכניסה למחשב",
  theme: "ערכת נושא",
  themeDescription: "הצבעים של האפליקציה ושל החלון הצף.",
  searchPlaceholder: "חיפוש בתמלולים",
  historyEmpty: "עדיין אין תמלולים.",
  quit: "יציאה",
  processingCancel: "ביטול התמלול",
  importedLabel: "קובץ",
  microphoneLabel: "הקלטה",
  processingEstimatePrefix: "כ־",
  visualizerAnalyzing: "בודקים את הקישור…",
  visualizerDownloading: "מורידים שמע",
  visualizerThinking: "מתמללים",
  workspaceConnectingHint: "אפשר להקליט אחרי שמנוע התמלול יורד.",
  workspaceRecordingHint: "מקליטים עכשיו.",
  clear: "ניקוי",
  close: "סגירה",
  clearSearch: "ניקוי שדה החיפוש",
  reset: "ביטול",
  save: "שמירה",
  loadMore: "עוד תמלולים",
  loadingApp: "טוענים…",
  loadingContent: "טוענים את התוכן…",
  startupFailed: "מלולי לא הצליחה להיטען. התמלולים שלך לא נמחקו.",
  appVersion: "גרסה",
  workspacePausedHint: "ההקלטה בהשהיה. אפשר להמשיך או לעצור ולתמלל.",
  workspaceProcessingHint: "מתמללים על המחשב.",
  overlaySetupRequired: "קודם צריך לסיים את ההגדרה בחלון הראשי.",
  overlayNotReady: "עדיין לא מוכנים",
  openMainWindow: "פתיחת החלון הראשי",
  microphoneBlockedTitle: "אין גישה למיקרופון",
  microphoneBlockedBody: "אפשר לאשר את מלולי בהגדרות המערכת ולחזור לכאן.",
  openSystemSettings: "פתיחת הגדרות המערכת",
  modelMissingBody: "בלי המנוע אפשר רק לעיין בתמלולים הקיימים.",
  recordingLimitSoon: "ההקלטה תיעצר ב־20:00 ותתומלל",
  recordingLimitReached: "ההקלטה הגיעה ל־20 דקות ונעצרה. מתמללים את מה שהוקלט.",
  importAudioCompact: "קובץ",
  importAudioHint: "גוררים לכאן או בוחרים",
  importAudioDrop: "משחררים כאן",
  mockTranscriptPrefix: "תמלול דמה עבור",
  mockTranscriptVideoFallback: "סרטון",
  mockTranscriptFileFallback: "קובץ",
  mockTranscriptLocal: "שלום, זהו תמלול דמה מקומי.",
  callLabel: "שיחה",
  callSpeakerMe: "אני",
  callSpeakerOthers: "משתתפים",
  callSuggestionZoom: "נראה שיש שיחה ב־Zoom",
  callSuggestionTeams: "נראה שיש שיחה ב־Teams",
  callSuggestionBrowser: "נראה שיש שיחה בדפדפן",
  callSuggestionBody: "לפני שמקליטים, עדכנו את המשתתפים וקבלו הסכמה כשהחוק דורש. המיקרופון מוקלט גם כשמושתקים בשיחה.",
  callAccept: "אני בשיחה, להקליט",
  callDismiss: "לא עכשיו",
  callRecording: "מקליטה שיחה",
  callStop: "עצירת הקלטת השיחה",
  callTitleZoom: "שיחה ב־Zoom",
  callTitleTeams: "שיחה ב־Teams",
  callTitleBrowser: "שיחה בדפדפן",
  callProcessing: "מתמללת שיחה",
  callProcessingWaiting: "ממשיכה כשההכתבה מסתיימת.",
  callFailed: "תמלול השיחה נכשל",
  callFailedBody: "השמע נשמר במחשב ואפשר לנסות שוב.",
  callDiscard: "מחיקה",
  callNoticeTitle: "הודעה על שיחה",
  callNoticeNoSpeech: "לא נשמע דיבור בשיחה, ולכן לא נוצר תמלול.",
  callNoticeOthersSilent: "לא נשמעו משתתפים. אם דיברו, צריך לאשר למלולי הקלטת שמע של המערכת.",
  callNoticePartial: "חלק מהשמע של השיחה לא נקלט, והתמלול חלקי.",
  callNoticeLowDisk: "אין מספיק מקום פנוי לשיחה. צריך לפחות 1GB.",
  callNoticeStartFailed: "ההקלטה לא התחילה. אפשר לנסות בשיחה הבאה.",
  callNoticeNeedsMicrophone: "צריך לאשר למלולי גישה למיקרופון כדי להקליט שיחה.",
  callDetection: "הצעה לתמלל שיחות",
  callDetectionDescription: "כששיחה מתחילה ב־Zoom, Teams או בדפדפן, מלולי מציעה להקליט. שום דבר לא מוקלט בלי לחיצה, והכול נשאר במחשב. מלולי לא מודיעה למשתתפים: הקליטו רק שיחות שאתם משתתפים בהן ועצרו כשאתם יוצאים. החובה לעמוד בחוק היא שלכם."
} as const;

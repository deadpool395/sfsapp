'use strict';
/** Shared multer configuration for spreadsheet uploads. */

const multer = require('multer');

/**
 * Files are held in memory: an upload is parsed, staged, and either committed
 * or discarded within the same session, so nothing needs to touch disk.
 */
const spreadsheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xlsm)$/i.test(file.originalname)) return cb(null, true);
    return cb(Object.assign(new Error('Upload an .xlsx file (Excel 2007 or newer).'), { status: 400 }));
  },
});

module.exports = { spreadsheetUpload };

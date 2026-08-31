'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || 'studentdb';
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;

const requiredVariables = {
  DB_USER,
  DB_PASSWORD,
  GCS_BUCKET_NAME
};

for (const [name, value] of Object.entries(requiredVariables)) {
  if (!value) {
    console.error(`Required environment variable is missing: ${name}`);
    process.exit(1);
  }
}

app.disable('x-powered-by');

app.use(express.urlencoded({
  extended: true,
  limit: '1mb'
}));

app.use(express.json({
  limit: '1mb'
}));

app.use(express.static(path.join(__dirname, 'public')));

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET_NAME);

let pool = null;

const allowedMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024
  },

  fileFilter: (request, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(
        new Error('Only PDF, DOC and DOCX resume files are allowed.')
      );
    }

    callback(null, true);
  }
});

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function initializeDatabase() {
  const maximumAttempts = 30;
  const delayMilliseconds = 5000;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      console.log(
        `Connecting to MySQL through the Auth Proxy. Attempt ${attempt}/${maximumAttempts}.`
      );

      pool = mysql.createPool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
      });

      await pool.query('SELECT 1');

      await pool.execute(`
        CREATE TABLE IF NOT EXISTS students (
          id INT AUTO_INCREMENT PRIMARY KEY,
          student_name VARCHAR(100) NOT NULL,
          student_id VARCHAR(50) NOT NULL,
          contact_no VARCHAR(20) NOT NULL,
          location VARCHAR(100) NOT NULL,
          resume_path VARCHAR(500) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      console.log('MySQL connection and students table are ready.');
      return;
    } catch (error) {
      console.error(
        `MySQL connection attempt ${attempt} failed: ${error.message}`
      );

      if (pool) {
        try {
          await pool.end();
        } catch (closeError) {
          console.error(
            `Unable to close failed pool: ${closeError.message}`
          );
        }

        pool = null;
      }

      if (attempt === maximumAttempts) {
        throw error;
      }

      await sleep(delayMilliseconds);
    }
  }
}

app.get('/health', (request, response) => {
  response.status(200).send('OK');
});

app.get('/healthz', (request, response) => {
  response.status(200).json({
    status: 'healthy'
  });
});

app.get('/readyz', async (request, response) => {
  if (!pool) {
    return response.status(503).json({
      status: 'not ready',
      reason: 'Database pool is not initialized.'
    });
  }

  try {
    await pool.query('SELECT 1');

    return response.status(200).json({
      status: 'ready'
    });
  } catch (error) {
    console.error(`Readiness check failed: ${error.message}`);

    return response.status(503).json({
      status: 'not ready'
    });
  }
});

app.get('/', (request, response) => {
  response.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.post(
  '/register',
  upload.single('resume'),
  async (request, response) => {
    let uploadedObjectName = null;

    try {
      const studentName = String(
        request.body.student_name || ''
      ).trim();

      const studentId = String(
        request.body.student_id || ''
      ).trim();

      const contactNumber = String(
        request.body.contact_no || ''
      ).trim();

      const location = String(
        request.body.location || ''
      ).trim();

      if (
        !studentName ||
        !studentId ||
        !contactNumber ||
        !location
      ) {
        return response.status(400).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Invalid Registration</title>
          </head>
          <body style="font-family: Arial; padding: 40px;">
            <h2>Invalid Registration</h2>
            <p>All student fields are required.</p>
            /Return to registration</a>
          </body>
          </html>
        `);
      }

      if (!request.file) {
        return response.status(400).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Resume Required</title>
          </head>
          <body style="font-family: Arial; padding: 40px;">
            <h2>Resume Required</h2>
            <p>Please upload a PDF, DOC or DOCX resume.</p>
            /Return to registration</a>
          </body>
          </html>
        `);
      }

      const safeOriginalName = path
        .basename(request.file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, '_');

      uploadedObjectName = [
        'resumes',
        new Date().toISOString().slice(0, 10),
        `${crypto.randomUUID()}-${safeOriginalName}`
      ].join('/');

      const gcsFile = bucket.file(uploadedObjectName);

      await gcsFile.save(request.file.buffer, {
        resumable: false,
        contentType: request.file.mimetype,

        metadata: {
          cacheControl: 'private, max-age=0, no-store'
        }
      });

      const resumePath =
        `gs://${GCS_BUCKET_NAME}/${uploadedObjectName}`;

      const insertStatement = `
        INSERT INTO students (
          student_name,
          student_id,
          contact_no,
          location,
          resume_path
        )
        VALUES (?, ?, ?, ?, ?)
      `;

      const [result] = await pool.execute(
        insertStatement,
        [
          studentName,
          studentId,
          contactNumber,
          location,
          resumePath
        ]
      );

      console.log(
        `Student registration created with ID ${result.insertId}.`
      );

      return response.status(201).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          >
          <title>Registration Successful</title>
        </head>

        <body style="
          font-family: Arial, sans-serif;
          padding: 40px;
          background: #eef4ff;
          color: #172033;
        ">
          <div style="
            max-width: 680px;
            margin: auto;
            background: white;
            padding: 32px;
            border-radius: 16px;
          ">
            <h2>Student Registered Successfully</h2>

            <p>
              Registration ID:
              <strong>${result.insertId}</strong>
            </p>

            <p>
              Resume stored securely in Cloud Storage.
            </p>

            <p>
              /Register another student</a>
            </p>

            <p>
              /studentsView students</a>
            </p>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      console.error('Upload or registration failed:', error);

      if (uploadedObjectName) {
        try {
          await bucket.file(uploadedObjectName).delete({
            ignoreNotFound: true
          });

          console.log(
            `Removed orphaned object ${uploadedObjectName}.`
          );
        } catch (cleanupError) {
          console.error(
            `Unable to remove uploaded object: ${cleanupError.message}`
          );
        }
      }

      return response.status(500).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Registration Failed</title>
        </head>
        <body style="font-family: Arial; padding: 40px;">
          <h2>Registration Failed</h2>
          <p>The registration could not be completed.</p>
          /Return to registration</a>
        </body>
        </html>
      `);
    }
  }
);

app.get('/students', async (request, response) => {
  try {
    const [students] = await pool.query(`
      SELECT
        id,
        student_name,
        student_id,
        contact_no,
        location,
        resume_path,
        created_at
      FROM students
      ORDER BY id DESC
      LIMIT 200
    `);

    const rows = students.map((student) => `
      <tr>
        <td>${escapeHtml(student.id)}</td>
        <td>${escapeHtml(student.student_name)}</td>
        <td>${escapeHtml(student.student_id)}</td>
        <td>${escapeHtml(student.contact_no)}</td>
        <td>${escapeHtml(student.location)}</td>
        <td>${escapeHtml(student.resume_path)}</td>
        <td>${escapeHtml(student.created_at)}</td>
      </tr>
    `).join('');

    return response.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >
        <title>Student Records</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 30px;
            background: #eef4ff;
            color: #172033;
          }

          .container {
            max-width: 1200px;
            margin: auto;
            background: white;
            padding: 30px;
            border-radius: 16px;
            overflow-x: auto;
          }

          table {
            width: 100%;
            border-collapse: collapse;
          }

          th,
          td {
            padding: 12px;
            border: 1px solid #dbe4f0;
            text-align: left;
          }

          th {
            background: #1e3c72;
            color: white;
          }

          tr:nth-child(even) {
            background: #f8fafc;
          }
        </style>
      </head>

      <body>
        <div class="container">
          <h2>Student Records</h2>

          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Student ID</th>
                <th>Contact</th>
                <th>Location</th>
                <th>Resume path</th>
                <th>Created at</th>
              </tr>
            </thead>

            <tbody>
              ${rows}
            </tbody>
          </table>

          <p>
            /Back to registration</a>
          </p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(
      `Unable to retrieve students: ${error.message}`
    );

    return response.status(500).send(
      'Unable to retrieve student records.'
    );
  }
});

app.use((error, request, response, next) => {
  console.error(`Request error: ${error.message}`);

  response.status(400).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Request Error</title>
    </head>
    <body style="font-family: Arial; padding: 40px;">
      <h2>Request Error</h2>
      <p>${escapeHtml(error.message)}</p>
      /Return to registration</a>
    </body>
    </html>
  `);
});

async function startApplication() {
  try {
    await initializeDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Student Registration application started on port ${PORT}.`
      );
    });
  } catch (error) {
    console.error(
      `Application startup failed: ${error.message}`
    );

    process.exit(1);
  }
}

startApplication();

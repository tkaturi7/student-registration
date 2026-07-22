const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const path = require("path");
const { Storage } = require("@google-cloud/storage");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_USER = process.env.DB_USER || "studentuser";
const DB_PASSWORD = process.env.DB_PASSWORD || "Password@123";
const DB_NAME = process.env.DB_NAME || "studentdb";
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;

if (!GCS_BUCKET_NAME) {
  console.error("GCS_BUCKET_NAME environment variable is missing");
  process.exit(1);
}

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET_NAME);

const db = mysql.createConnection({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error("Database Connection Failed");
    console.error(err);
    return;
  }

  console.log("MySQL Connected");
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/register", upload.single("resume"), async (req, res) => {
  try {
    console.log("Form Data:", req.body);
    console.log("File:", req.file ? req.file.originalname : "No file");

    const student_name = req.body.student_name;
    const student_id = req.body.student_id;
    const contact_no = req.body.contact_no;
    const location = req.body.location;

    if (!req.file) {
      return res.status(400).send("Resume file is required");
    }

    const safeOriginalName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectName = `resumes/${Date.now()}-${safeOriginalName}`;

    const file = bucket.file(objectName);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: req.file.mimetype
      }
    });

    const resume_path = `gs://${GCS_BUCKET_NAME}/${objectName}`;

    const sql = `
      INSERT INTO students
      (
        student_name,
        student_id,
        contact_no,
        location,
        resume_path
      )
      VALUES (?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [
        student_name,
        student_id,
        contact_no,
        location,
        resume_path
      ],
      (err, result) => {
        if (err) {
          console.error("Insert Error:");
          console.error(err);

          return res.status(500).send(`
            <h2>Database Error</h2>
            <pre>${err.message}</pre>
          `);
        }

        console.log("Record Inserted");

        res.send(`
          <html>
          <body style="font-family: Arial; padding: 40px;">
            <h2>Student Registered Successfully</h2>
            <p>Resume uploaded to: ${resume_path}</p>
            /Register Another Student</a>
            <br><br>
            /studentsView Students</a>
          </body>
          </html>
        `);
      }
    );
  } catch (err) {
    console.error("Upload/Register Error:");
    console.error(err);

    res.status(500).send(`
      <h2>Application Error</h2>
      <pre>${err.message}</pre>
    `);
  }
});

app.get("/students", (req, res) => {
  db.query(
    "SELECT * FROM students ORDER BY id DESC",
    (err, results) => {
      if (err) {
        return res.status(500).send(err.message);
      }

      let html = `
        <html>
        <head>
          <title>Student Records</title>
        </head>
        <body style="font-family: Arial; padding: 40px;">
          <h2>Student Records</h2>
          <table border="1" cellpadding="10" cellspacing="0">
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Student ID</th>
              <th>Contact</th>
              <th>Location</th>
              <th>Resume</th>
              <th>Created At</th>
            </tr>
      `;

      results.forEach((row) => {
        html += `
          <tr>
            <td>${row.id}</td>
            <td>${row.student_name}</td>
            <td>${row.student_id}</td>
            <td>${row.contact_no}</td>
            <td>${row.location}</td>
            <td>${row.resume_path}</td>
            <td>${row.created_at}</td>
          </tr>
        `;
      });

      html += `
          </table>
          <br>
          /Back To Registration</a>
        </body>
        </html>
      `;

      res.send(html);
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server Started On Port ${PORT}`);
});

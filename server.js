"use strict";
const express = require("express");
const multer = require("multer");
const mysql = require("mysql2/promise");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const app = express();
const port = Number(process.env.PORT || 3000);
const storage = new Storage();
const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 5 * 1024 * 1024}});
let pool;
function getPool() {
  if (!pool) pool = mysql.createPool({host: process.env.DB_HOST || "127.0.0.1", port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME || "studentdb", waitForConnections: true, connectionLimit: 5});
  return pool;
}
async function initializeDatabase() {
  await getPool().execute(`CREATE TABLE IF NOT EXISTS students (id BIGINT AUTO_INCREMENT PRIMARY KEY, student_name VARCHAR(100) NOT NULL, student_id VARCHAR(50) NOT NULL UNIQUE, contact_no VARCHAR(20) NOT NULL, location VARCHAR(100) NOT NULL, resume_object VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
}
app.disable("x-powered-by");
app.use(express.urlencoded({extended: false}));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req,res)=>res.status(200).json({status:"ok"}));
app.get("/healthz", (_req,res)=>res.status(200).json({status:"alive"}));
app.get("/readyz", async (_req,res)=>{try{await getPool().query("SELECT 1");res.status(200).json({status:"ready"});}catch{res.status(503).json({status:"not-ready"});}});
app.post("/register", upload.single("resume"), async (req,res)=>{
  try {
    if (!req.file) return res.status(400).send("Resume is required.");
    const allowed = new Set(["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
    if (!allowed.has(req.file.mimetype)) return res.status(400).send("Unsupported resume type.");
    const bucketName=process.env.GCS_BUCKET_NAME;
    if (!bucketName) return res.status(500).send("Storage bucket is not configured.");
    const safeId=String(req.body.student_id||"").replace(/[^a-zA-Z0-9_-]/g,"_");
    const objectName=`resumes/${Date.now()}-${safeId}-${path.basename(req.file.originalname)}`;
    await storage.bucket(bucketName).file(objectName).save(req.file.buffer,{contentType:req.file.mimetype,resumable:false});
    await getPool().execute("INSERT INTO students (student_name,student_id,contact_no,location,resume_object) VALUES (?,?,?,?,?)",[req.body.student_name,req.body.student_id,req.body.contact_no,req.body.location,objectName]);
    res.status(201).send("Registration completed.");
  } catch(error) { console.error(error); res.status(500).send("Registration failed."); }
});
initializeDatabase().then(()=>app.listen(port,"0.0.0.0",()=>console.log(`Application listening on ${port}`))).catch(error=>{console.error("Database initialization failed",error);process.exit(1);});

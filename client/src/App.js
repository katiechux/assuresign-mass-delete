import React, { useState } from "react";
import Papa from "papaparse";
import "./App.css";

function App() {
  const [csvData, setCsvData] = useState([]);
  const [contextIdInput, setContextIdInput] = useState('');
  const [response, setResponse] = useState(null);

  // Handle CSV upload
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        console.log("Parsed CSV:", result.data);
        setCsvData(result.data);
      },
    });
  };

  const handleChange = (event) => {
    setContextIdInput(event.target.value);
  };

  // Call Express SOAP API
  const sendToServer = async () => {
    if (!contextIdInput) {
      alert("Account Context Identifier is required.");
      return false;
    }
    if (csvData.length < 1 ) {
      alert("Please select a CSV file.");
      return false;
    }
    //debugger;
    try {
      const res = await fetch("/api/send-soap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: csvData, contextId: contextIdInput }),
      });

      if (!res.ok) throw new Error("Server error");

      const json = await res.json();
      console.log("Server response:", json);
      alert("Deletion Requests Submitted! Please monitor server requests.");
      setResponse(json.soapResponse);
    } catch (err) {
      console.error("Error sending SOAP request:", err);
    }
  };

  return (
    <div class="container" style={{ padding: "20px" }}>
      <title>AssureSign Mass Envelope Deletion</title>
      <img width="100" height="100" src="https://www.nintex.com/wp-content/uploads/2024/10/nintex-logo-color.svg" class="attachment-large size-large" alt="Nintex logo"></img>
      <h1>AssureSign Mass Envelope Deletion</h1>

      <div>
        <label for="contextId" class="label">DocumentNOW® Account Context Identifier</label>
        <input type="text" id="contextId" size="40" required value={contextIdInput} onChange={handleChange}/>
      </div>

      <input type="file" accept=".csv" onChange={handleFileUpload} />

      {csvData.length > 0 && (
        <>
          <button onClick={sendToServer} style={{ padding: "0.5rem 1rem", backgroundColor:"#be0075", color:"#FFFFFF", border:"1px solid #be0075", fontFamily:"Open Sans, sans-serif", fontWeight:"bold"}}>
            Send to SOAP Service
          </button>
        </>
      )}

      {response && (
        <div style={{ marginTop: "20px" }}>
          <h2>SOAP Response</h2>
          <pre>{response}</pre>
        </div>
      )}
    </div>
  );
}

export default App;

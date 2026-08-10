import sys
import os
from PIL import Image, ImageDraw, ImageFont

wireframes = {
    "1_Login_Page.png": """---------------------------------------------------
                    CLEANLYTICS
---------------------------------------------------

              Welcome Back!

 Email      _______________________

 Password   _______________________

           [ Login ]

      Forgot Password?

---------------- OR ----------------

      [ Sign in with Google ]

Don't have an account?
         Register Here
---------------------------------------------------""",
    
    "2_Registration_Page.png": """---------------------------------------------------
                 REGISTER
---------------------------------------------------

 Full Name      ___________________

 Email          ___________________

 Password       ___________________

 Confirm Pass   ___________________

        [ Create Account ]

Already have an account?
          Login
---------------------------------------------------""",

    "3_Dashboard.png": """--------------------------------------------------------------
LOGO          Dashboard        Profile      Logout
--------------------------------------------------------------

 Upload Dataset

 Recent Files
 -------------------------
 sales.csv
 employee.xlsx
 customer.csv

--------------------------------------------------------------

 Quick Actions

 [Cleaning]
 [Transformation]
 [Visualization]
 [Export]

--------------------------------------------------------------""",

    "4_Upload_Dataset.png": """---------------------------------------------------

Upload Dataset

+--------------------------------------+
|                                      |
|    Drag & Drop CSV / Excel File      |
|                                      |
+--------------------------------------+

         [Browse File]

Supported Formats:
CSV (.csv)
Excel (.xlsx)

---------------------------------------------------""",

    "5_Dataset_Preview.png": """---------------------------------------------------

Dataset Preview

---------------------------------------------------
| Name | Department | Salary | Experience |
---------------------------------------------------
| John | HR         | 45000  | 2 Years    |
| Sam  | Sales      | 52000  | 3 Years    |
| ...                                  |
---------------------------------------------------

Rows: 500

[Proceed to Cleaning]

---------------------------------------------------""",

    "6_Data_Cleaning.png": """---------------------------------------------------

Data Cleaning

[x] Remove Duplicates

[x] Handle Missing Values

Method:
( ) Mean
( ) Median
( ) Mode
( ) Delete Rows

[x] Trim Whitespaces

[x] Convert Text to Lowercase

            [Apply Cleaning]

---------------------------------------------------""",

    "7_Data_Transformation.png": """---------------------------------------------------

Data Transformation

Column Operations

[Rename Column]

[Split Column]

[Merge Columns]

[Filter Rows]

[Sort Data]

[Group By Aggregation]

            [Apply Changes]

---------------------------------------------------""",

    "8_Data_Visualization.png": """---------------------------------------------------

Visualization

Select Chart

( ) Bar Chart

( ) Line Chart

( ) Pie Chart

( ) Scatter Plot

X-Axis: __________

Y-Axis: __________

      [Generate Chart]

------------------------------

      Chart Display Area

------------------------------

---------------------------------------------------""",

    "9_Export_Module.png": """---------------------------------------------------

Export Data

Export Format

( ) CSV

( ) Excel

( ) PDF Report

        [Download]

---------------------------------------------------"""
}

# Try to use a monospace font, fallback to default if necessary
try:
    font = ImageFont.truetype("consola.ttf", 16)
except IOError:
    try:
        font = ImageFont.truetype("cour.ttf", 16)
    except IOError:
        font = ImageFont.load_default()

for filename, text in wireframes.items():
    # Calculate image size based on text
    lines = text.split('\n')
    
    # Get max width and total height
    max_width = 0
    total_height = 0
    
    for line in lines:
        bbox = font.getbbox(line)
        if bbox:
            width = bbox[2] - bbox[0]
            max_width = max(max_width, width)
        total_height += 20 # fixed line height
        
    width = max(max_width + 60, 600)
    height = max(total_height + 60, 400)
    
    # Create image with white background
    img = Image.new('RGB', (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    
    # Draw text
    y_text = 30
    for line in lines:
        draw.text((30, y_text), line, font=font, fill=(0, 0, 0))
        y_text += 20
        
    # Save the image in the brain folder
    output_path = os.path.join(r"C:\Users\Sankari\.gemini\antigravity\brain\67d049bc-34ed-4a42-bd46-c420a483c694", filename)
    img.save(output_path)
    print(f"Saved {output_path}")

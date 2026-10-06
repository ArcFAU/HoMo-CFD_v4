// Exports 3D data for HoMo CFD's 3D viewer into 3D-data/ of the case folder (EnSight Gold):
// - <sim>.case: the car's wall surfaces with Cp, skin friction, wall shear stress, y+ and flow fields,
// - <sim>_flow.case: the simulation's derived parts "Lambda2" (vortex cores: iso-surface of
//   neg(Lambda2)) and "Bad_Cells" (iso-surface around bad mesh cells), when they exist, with the
//   fields defined in the flow (wall-only fields such as CpX = Cp * Norm_Area_x divide by a face
//   area that is zero on some iso-surface faces, which stops STAR-CCM+ with a floating point error),
// - <sim>_streamlines.case: streamlines from rows of start points 5 cm in front of the car, across
//   its width and height, with the flow fields (HoMo CFD shows them up to 1 m behind the car),
// - fields.txt: every field function of the simulation, to look up names.
// The car also gets the wall shear stress direction (WallShearStressX/Y/Z) for the viewer's surface
// flow lines. The three exports run separately, so a problem with the flow parts or the
// streamlines never costs the car data.
// postprocessing.java plays it at the end; it can also be played on its own in STAR-CCM+
// (File > Macro > Play Macro). Written for STAR-CCM+ 2506 (20.04).
//
// Values are per cell. Fields or parts a simulation does not have are left out. Regions named
// "Cells deleted from ..." (left over from mesh repair, no solution) are skipped. Problems are
// printed to the log and never stop the post-processing. Parts, reports and field functions the
// macro creates are removed again, so the simulation is left as it was.
//
// Optional lines in the case's Settings file:
//   3D-Data/Vortices : false              no Lambda2 part
//   3D-Data/Bad Cells : false             no Bad_Cells part
//   3D-Data/Vortices Iso Value : 30000    only used when the simulation has no "Lambda2" part:
//                                         threshold of neg(Lambda2) for a temporary iso-surface
//   3D-Data/Streamlines : false           no streamlines
//   3D-Data/Streamline Rows : 20          rows of start points over the car's height
//   3D-Data/Streamlines Per Row : 40      start points per row across the car's width (at least 2)
//   3D-Data/Surface Flow : false          no wall shear stress direction

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Vector;

import star.base.neo.DoubleVector;
import star.base.neo.NeoProperty;
import star.base.report.MaxReport;
import star.base.report.MinReport;
import star.base.report.ScalarReport;
import star.common.*;
import star.vis.IntegrationDirection;
import star.vis.IsoMode;
import star.vis.IsoPart;
import star.vis.LineSeed;
import star.vis.SeedMode;
import star.vis.StreamPart;

public class export3D extends StarMacro {

    // Scalar fields, by STAR-CCM+ name or display name (punctuation and case ignored).
    private static final String[] FIELDS = {"PressureCoefficient", "TotalPressureCoefficient", "CpX", "CpZ", "CpZ-CpX",
            "SkinFrictionCoefficient", "WallYplus"};
    // Vector fields, exported as their magnitude.
    private static final String[] MAGNITUDES = {"WallShearStress", "Velocity", "VorticityVector"};
    // Fields also exported on the flow parts (defined away from walls).
    private static final String[] FLOW_FIELDS = {"PressureCoefficient", "TotalPressureCoefficient"};
    private static final String[] FLOW_MAGNITUDES = {"Velocity", "VorticityVector"};
    // Wall boundaries that belong to the wind tunnel, not to the car (compared ignoring case).
    private static final String[] SKIPPED = {"floor", "ground", "road", "walls", "wall", "tunnel", "symmetry", "sym", "top", "side"};
    // The team's lambda2 iso value (derived part "Lambda2" in UPSI_CFD_BASE).
    private static final double DEFAULT_VORTEX_ISO = 30000;
    // Streamlines: start points this far in front of the car's nose (m), traced at most this far
    // behind its tail (m; the viewer cuts them off there), in rows over the car's height.
    private static final double STREAM_GAP = 0.05;
    private static final double STREAM_WAKE = 1.0;
    // A dense grid; the viewer chooses which of these lines to show.
    private static final int STREAM_ROWS = 20;
    private static final int STREAM_PER_ROW = 40;

    private Simulation simulation;
    // Created by this macro; removed again at the end.
    private final ArrayList<Part> temporaryParts = new ArrayList<>();
    private final ArrayList<FieldFunction> temporaryFunctions = new ArrayList<>();

    @Override
    public void execute() {
        simulation = getActiveSimulation();
        try {
            File folder = new File(simulation.getSessionDir(), "3D-data");
            folder.mkdirs();
            listFields(new File(folder, "fields.txt"));

            ArrayList<Region> regions = new ArrayList<>();
            for (Region region : simulation.getRegionManager().getRegions()) {
                if (!region.getPresentationName().toLowerCase(Locale.ROOT).startsWith("cells deleted")) {
                    regions.add(region);
                }
            }
            ArrayList<Boundary> surfaces = new ArrayList<>();
            for (Region region : regions) {
                for (Boundary boundary : region.getBoundaryManager().getBoundaries()) {
                    if (boundary.getBoundaryType() instanceof WallBoundary && isCar(boundary.getPresentationName())) {
                        surfaces.add(boundary);
                    }
                }
            }
            ArrayList<FieldFunction> fields = fields(FIELDS, MAGNITUDES, true);
            if (!"false".equalsIgnoreCase(setting("3D-Data/Surface Flow"))) {
                fields.addAll(shearComponents());
            }
            ArrayList<FieldFunction> flowFields = fields(FLOW_FIELDS, FLOW_MAGNITUDES, false);

            ArrayList<Part> parts = new ArrayList<>();
            if (!"false".equalsIgnoreCase(setting("3D-Data/Vortices"))) {
                Part lambda2 = derivedPart("Lambda2");
                if (lambda2 == null) {
                    lambda2 = vortexPart(regions);
                }
                if (lambda2 != null) {
                    parts.add(lambda2);
                }
            }
            if (!"false".equalsIgnoreCase(setting("3D-Data/Bad Cells"))) {
                Part badCells = derivedPart("Bad_Cells");
                if (badCells != null) {
                    parts.add(badCells);
                }
            }

            String name = simulation.getPresentationName();
            if (surfaces.isEmpty() || fields.isEmpty()) {
                simulation.println("export3D: no car surfaces or fields (" + surfaces.size() + " surfaces, " + fields.size() + " fields)");
            } else {
                export(new File(folder, name + ".case"), surfaces, new ArrayList<Part>(), fields);
                simulation.println("export3D: " + surfaces.size() + " car surfaces with " + fields.size() + " fields written");
            }
            if (!parts.isEmpty() && !flowFields.isEmpty()) {
                try {
                    export(new File(folder, name + "_flow.case"), new ArrayList<Boundary>(), parts, flowFields);
                    ArrayList<String> partNames = new ArrayList<>();
                    for (Part part : parts) {
                        partNames.add(part.getPresentationName());
                    }
                    simulation.println("export3D: flow parts " + partNames + " with " + flowFields.size() + " fields written");
                } catch (Exception e) {
                    simulation.println("export3D: flow parts failed, the car data is complete: " + e);
                }
            }
            if (!"false".equalsIgnoreCase(setting("3D-Data/Streamlines")) && !flowFields.isEmpty()) {
                try {
                    ArrayList<Part> streamlines = streamlines(regions, surfaces);
                    if (!streamlines.isEmpty()) {
                        export(new File(folder, name + "_streamlines.case"), new ArrayList<Boundary>(), streamlines, flowFields);
                        simulation.println("export3D: " + streamlines.size() + " rows of streamlines with " + flowFields.size() + " fields written");
                    }
                } catch (Exception e) {
                    simulation.println("export3D: streamlines failed, the other 3D data is complete: " + e);
                }
            }
        } catch (Exception e) {
            simulation.println("export3D failed, post-processing continues: " + e);
        } finally {
            try {
                simulation.getPartManager().removeObjects(temporaryParts);
                simulation.getFieldFunctionManager().removeObjects(temporaryFunctions);
            } catch (Exception e) {
                simulation.println("export3D: could not remove its temporary parts or field functions: " + e);
            }
        }
    }

    // Wall shear stress direction for the viewer's surface flow lines: its x, y and z components as
    // field functions WallShearStressX/Y/Z (made for the export when the simulation has none).
    private ArrayList<FieldFunction> shearComponents() {
        ArrayList<FieldFunction> found = new ArrayList<>();
        FieldFunction shear = find("WallShearStress");
        if (shear == null) {
            simulation.println("export3D: no field function WallShearStress, no surface flow");
            return found;
        }
        FieldFunctionManager functions = simulation.getFieldFunctionManager();
        for (int axis = 0; axis < 3; axis++) {
            String name = "WallShearStress" + "XYZ".charAt(axis);
            if (functions.hasFunction(name)) {
                found.add(functions.getFunction(name));
                continue;
            }
            UserFieldFunction component = functions.createFieldFunction();
            temporaryFunctions.add(component);
            component.setFunctionName(name);
            component.setPresentationName(name);
            component.setDefinition("$${" + shear.getFunctionName() + "}[" + axis + "]");
            found.add(component);
        }
        return found;
    }

    // One streamline part per row of start points: a line across the car's width, STREAM_GAP in
    // front of its nose, rows evenly over its height; traced downstream through all regions.
    private ArrayList<Part> streamlines(ArrayList<Region> regions, ArrayList<Boundary> surfaces) {
        ArrayList<Part> parts = new ArrayList<>();
        FieldFunction velocity = find("Velocity");
        FieldFunction position = find("Position");
        if (velocity == null || position == null || surfaces.isEmpty()) {
            simulation.println("export3D: no Velocity or Position field function or no car surfaces, no streamlines");
            return parts;
        }
        // Everything in metres: simulations may use mm as their default length unit.
        Units metres = simulation.getUnitsManager().getObject("m");
        double[] lo = new double[3], hi = new double[3];
        for (int axis = 0; axis < 3; axis++) {
            lo[axis] = extreme(MinReport.class, position.getComponentFunction(axis), surfaces, metres);
            hi[axis] = extreme(MaxReport.class, position.getComponentFunction(axis), surfaces, metres);
        }
        int rows = count("3D-Data/Streamline Rows", STREAM_ROWS);
        int perRow = Math.max(2, count("3D-Data/Streamlines Per Row", STREAM_PER_ROW));
        double x = hi[0] + STREAM_GAP;
        // Streamlines bend, so they may run longer than the straight way to STREAM_WAKE behind the car
        // (m; the first run, with a value thousands of times too large, showed the limit is in metres).
        double length = 3 * (x - (lo[0] - STREAM_WAKE));
        for (int row = 0; row < rows; row++) {
            double z = lo[2] + (hi[2] - lo[2]) * (row + 0.5) / rows;
            StreamPart part = simulation.getPartManager().createStreamPart();
            temporaryParts.add(part);
            part.setPresentationName("Streamlines " + (row + 1));
            part.getInputParts().setObjects(regions);
            part.setFieldFunction(velocity);
            part.setMode(SeedMode.LINE);
            LineSeed seed = part.getLineSeed();
            seed.getPoint1Coordinate().setCoordinate(metres, metres, metres, new DoubleVector(new double[] {x, lo[1], z}));
            seed.getPoint2Coordinate().setCoordinate(metres, metres, metres, new DoubleVector(new double[] {x, hi[1], z}));
            // A resolution of n gives n + 1 points from end to end.
            seed.setResolution(perRow - 1);
            part.getIntegrator().setDirection(IntegrationDirection.FORWARD);
            part.getIntegrator().setMaxPropagation(length);
            part.getIntegrator().setMaximumNumberOfSteps(50000);
            parts.add(part);
        }
        simulation.println(String.format(Locale.ROOT, "export3D: car x %.3f to %.3f, y %.3f to %.3f, z %.3f to %.3f m; %d rows of %d streamlines from x = %.3f m",
                lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], rows, perRow, x));
        return parts;
    }

    // Minimum or maximum of a field over the car's surfaces, in the given units, from a temporary report.
    private <T extends ScalarReport> double extreme(Class<T> type, FieldFunction function, ArrayList<Boundary> surfaces, Units units) {
        T report = simulation.getReportManager().createReport(type);
        try {
            report.setFieldFunction(function);
            report.setUnits(units);
            report.getParts().setObjects(surfaces);
            return report.getReportMonitorValue();
        } finally {
            simulation.getReportManager().removeObjects(report);
        }
    }

    // A whole number from the Settings file (1 to 200), or the default.
    private int count(String key, int fallback) {
        String value = setting(key);
        if (value == null) {
            return fallback;
        }
        try {
            return Math.max(1, Math.min(200, Integer.parseInt(value)));
        } catch (NumberFormatException e) {
            simulation.println("export3D: " + key + " is not a whole number, using " + fallback);
            return fallback;
        }
    }

    // Boundaries and derived parts only (regions would add the whole volume mesh), values per cell.
    private void export(File caseFile, ArrayList<Boundary> surfaces, ArrayList<Part> parts, ArrayList<FieldFunction> fields) {
        simulation.getImportManager().export(caseFile.getPath(), new ArrayList<Region>(), surfaces, parts,
                new ArrayList<PartSurface>(), fields,
                NeoProperty.fromString("{'exportFormatType': 2, 'appendToFile': false, 'solutionOnly': false, 'dataAtVerts': false}"));
    }

    // Scalars as they are, vectors as their magnitude; missing ones are reported once (report = true).
    private ArrayList<FieldFunction> fields(String[] scalars, String[] vectors, boolean report) {
        ArrayList<FieldFunction> found = new ArrayList<>();
        for (String name : scalars) {
            FieldFunction function = find(name);
            if (function != null) {
                found.add(function);
            } else if (report) {
                simulation.println("export3D: no field function " + name + ", left out");
            }
        }
        for (String name : vectors) {
            FieldFunction function = find(name);
            if (function != null) {
                found.add(function.getMagnitudeFunction());
            } else if (report) {
                simulation.println("export3D: no field function " + name + ", left out");
            }
        }
        return found;
    }

    private Part derivedPart(String name) {
        for (Part part : simulation.getPartManager().getObjects()) {
            if (part.getPresentationName().equalsIgnoreCase(name)) {
                return part;
            }
        }
        return null;
    }

    // Fallback when the simulation has no "Lambda2" part: a temporary iso-surface of neg(Lambda2)
    // (vortex cores positive); a plain lambda2 function gets the negative threshold.
    private IsoPart vortexPart(ArrayList<Region> regions) {
        FieldFunction lambda2 = null;
        for (FieldFunction function : simulation.getFieldFunctionManager().getObjects()) {
            String key = simplified(function.getPresentationName()) + " " + simplified(function.getFunctionName());
            if (key.contains("lambda2") && (lambda2 == null || key.contains("neg"))) {
                lambda2 = function;
            }
        }
        if (lambda2 == null) {
            simulation.println("export3D: no Lambda2 part or lambda2 field function, no vortices");
            return null;
        }
        double iso = DEFAULT_VORTEX_ISO;
        try {
            String value = setting("3D-Data/Vortices Iso Value");
            if (value != null) {
                iso = Math.abs(Double.parseDouble(value));
            }
        } catch (NumberFormatException e) {
            simulation.println("export3D: Vortices Iso Value is not a number, using " + iso);
        }
        boolean negated = (simplified(lambda2.getPresentationName()) + simplified(lambda2.getFunctionName())).contains("neg");
        IsoPart part = simulation.getPartManager().createIsoPart(new Vector<>(regions), lambda2);
        temporaryParts.add(part);
        part.setPresentationName("Lambda2");
        part.setMode(IsoMode.ISOVALUE_SINGLE);
        part.getSingleIsoValue().setValue(negated ? iso : -iso);
        simulation.println("export3D: temporary Lambda2 part = " + lambda2.getPresentationName() + " at " + (negated ? iso : -iso));
        return part;
    }

    private FieldFunction find(String name) {
        FieldFunctionManager functions = simulation.getFieldFunctionManager();
        if (functions.hasFunction(name)) {
            return functions.getFunction(name);
        }
        for (FieldFunction function : functions.getObjects()) {
            if (simplified(function.getPresentationName()).equals(simplified(name))
                    || simplified(function.getFunctionName()).equals(simplified(name))) {
                return function;
            }
        }
        return null;
    }

    private void listFields(File file) {
        try (FileWriter out = new FileWriter(file)) {
            out.write("# Field functions of " + simulation.getPresentationName() + ": name | display name | type\n");
            for (FieldFunction function : simulation.getFieldFunctionManager().getObjects()) {
                out.write(function.getFunctionName() + " | " + function.getPresentationName() + " | " + function.getTypeAsEnum() + "\n");
            }
        } catch (Exception e) {
            simulation.println("export3D: could not write " + file + ": " + e);
        }
    }

    // A "Group/Name : value" line of the case's Settings file, or null.
    private String setting(String key) {
        File file = new File(simulation.getSessionDir(), "Settings");
        try (BufferedReader in = new BufferedReader(new FileReader(file))) {
            String line;
            while ((line = in.readLine()) != null) {
                String[] parts = line.split(" : ", 2);
                if (parts.length == 2 && parts[0].trim().equals(key)) {
                    return parts[1].trim();
                }
            }
        } catch (IOException e) {
            return null;
        }
        return null;
    }

    private static String simplified(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    private static boolean isCar(String name) {
        String lower = name.toLowerCase(Locale.ROOT).trim();
        if (lower.startsWith("internal") || lower.contains("interface") || lower.contains("[")) {
            return false;
        }
        for (String skipped : SKIPPED) {
            if (lower.equals(skipped)) {
                return false;
            }
        }
        return true;
    }
}
